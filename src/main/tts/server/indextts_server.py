#!/usr/bin/env python3
"""Cyrene · IndexTTS thin HTTP server.

Enhanced-usability / auto-launch: this server is spawned by the main process
(see src/main/tts/indextts-server.ts) so the user never has to run a PowerShell
command themselves — they only point the engine at a model dir + Python path.

Dependency note: we deliberately use ONLY the Python standard library
`http.server` on top of what `index-tts` + `torch` already install, so the
bundled server adds ZERO extra pip packages (no FastAPI / uvicorn / flask).

HTTP contract:
  GET  /health  -> 200 {"status":"ok","engine":...}        (used by the runner to probe readiness)
  POST /tts     -> JSON in  {text, ref_audio_path, prompt_text,
                             speed_factor, text_lang, prompt_lang, media_type}
                  JSON out {audio_base64, format:"wav"|"mp3"}
                  (append ?raw=1 or header X-Raw-Audio: 1 to get raw wav bytes instead)

The JSON body is the standard index-tts / GPT-SoVITS shared contract that
src/main/tts/indextts-engine.ts already speaks. Text and ref_audio_path are
required; prompt_text / speed_factor / text_lang / prompt_lang / media_type are
accepted for contract compatibility.

CLI:  python indextts_server.py --model-dir <dir> --port <port>
                                [--engine v2|v2_5] [--host 127.0.0.1] [--fp16]
"""

import argparse
import base64
import inspect
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Engine state: loaded once, guarded by a lock because IndexTTS2 is not
# thread-safe for concurrent inference.
# ---------------------------------------------------------------------------
_LOCK = threading.Lock()
_TTS = None
_MODEL_DIR = ""
_ENGINE = "v2"
_USE_FP16 = True


def _load_engine(force: bool = False):
    """Lazily construct the IndexTTS2 model. Default engine is IndexTTS 2.0."""
    global _TTS
    if _TTS is not None and not force:
        return _TTS

    cfg_path = os.path.join(_MODEL_DIR, "config.yaml")
    if not os.path.exists(cfg_path):
        raise FileNotFoundError(f"IndexTTS config.yaml not found in {_MODEL_DIR}")

    if _ENGINE == "v2_5":
        # IndexTTS 2.5: infer_v2_5 module. Flags differ across builds, so we
        # fall back to a minimal {cfg_path, model_dir} set if the signature
        # rejects them. This is best-effort; the primary target is 2.0.
        from indextts.infer_v2_5 import IndexTTS2  # type: ignore
        kwargs = dict(cfg_path=cfg_path, model_dir=_MODEL_DIR, use_cuda_kernel=False, use_deepspeed=False)
        if _USE_FP16:
            kwargs["use_bf16"] = True
    else:
        # IndexTTS 2.0: infer_v2 uses `use_fp16` (NOT use_bf16).
        from indextts.infer_v2 import IndexTTS2
        kwargs = dict(
            cfg_path=cfg_path,
            model_dir=_MODEL_DIR,
            use_fp16=_USE_FP16,
            use_cuda_kernel=False,
            use_deepspeed=False,
        )

    try:
        _TTS = IndexTTS2(**kwargs)
    except TypeError:
        # Some builds only accept {cfg_path, model_dir}; retry minimal.
        _TTS = IndexTTS2(cfg_path=cfg_path, model_dir=_MODEL_DIR)

    print(f">> IndexTTS engine ready: {_ENGINE} (device={getattr(_TTS, 'device', '?')})", flush=True)
    return _TTS


def _synthesize(payload: dict, raw: bool):
    text = (payload.get("text") or "").strip()
    ref_audio = (payload.get("ref_audio_path") or "").strip()
    if not text:
        return 400, {"error": "missing text"}
    if not ref_audio or not os.path.exists(ref_audio):
        return 400, {"error": f"missing or invalid ref_audio_path: {ref_audio}"}

    out_format = (payload.get("media_type") or "wav").lower()
    if out_format not in ("wav", "mp3"):
        out_format = "wav"

    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with _LOCK:  # serialize model load + inference (IndexTTS2 is not thread-safe)
            tts = _load_engine()
            # 版本无关地传 lang：2.5 的 infer 必填 lang；2.0 可能/可能不接受 lang。
            # 仅当 infer 签名里有 lang 参数才传，避免 TypeError；缺省按文本 CJK→zh / 否则 en。
            lang = (payload.get("text_lang") or payload.get("prompt_lang") or "").strip().lower()
            if lang not in ("zh", "en", "ja", "es", "ar", "yue"):
                lang = "zh" if re.search(r"[\u4e00-\u9fff]", text) else "en"
            infer_kwargs = dict(spk_audio_prompt=ref_audio, text=text, output_path=wav_path, verbose=False)
            if "lang" in inspect.signature(tts.infer).parameters:
                infer_kwargs["lang"] = lang
            tts.infer(**infer_kwargs)
            # 释放 CUDA 缓存 + 回收，防反复合成累积显存（IndexTTS-2.5 分段生成较吃显存）
            try:
                import gc
                import torch
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
        with open(wav_path, "rb") as f:
            audio = f.read()
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass

    if not audio:
        return 500, {"error": "IndexTTS produced empty audio"}

    if raw:
        return 200, audio
    return 200, {"audio_base64": base64.b64encode(audio).decode("ascii"), "format": out_format}


class _Handler(BaseHTTPRequestHandler):
    server_version = "CyreneIndexTTS/1.0"

    def log_message(self, fmt, *args):  # quieter than default
        if os.environ.get("CYRENE_INDEXTTS_VERBOSE"):
            sys.stderr.write("[indextts] %s\n" % (fmt % args))

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/health":
            self._send_json(200, {"status": "ok", "engine": _ENGINE})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.rstrip("/").endswith("/tts"):
            self._send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("body must be a JSON object")
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": f"invalid JSON: {exc}"})
            return
        raw = "raw=1" in parsed.query or self.headers.get("X-Raw-Audio") == "1"
        try:
            status, result = _synthesize(payload, raw)
            if isinstance(result, bytes):
                self._send_bytes(status, result, "audio/wav")
            else:
                self._send_json(status, result)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("[indextts] /tts error: %s\n" % exc)
            self._send_json(500, {"error": str(exc)})


def main():
    global _MODEL_DIR, _ENGINE, _USE_FP16
    parser = argparse.ArgumentParser(description="Cyrene IndexTTS thin server")
    parser.add_argument("--model-dir", required=True, help="IndexTTS model checkpoint directory")
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--engine", choices=["v2", "v2_5"], default="v2")
    parser.add_argument("--fp16", action="store_true", default=True, help="Use FP16/BF16 if available")
    args = parser.parse_args()

    if not os.path.isdir(args.model_dir):
        print(f"[indextts] model dir does not exist: {args.model_dir}", flush=True)
        sys.exit(1)

    _MODEL_DIR = args.model_dir
    _ENGINE = args.engine
    _USE_FP16 = args.fp16
    # Pre-load the model before accepting requests so the runner's ready-probe
    # (/health) only succeeds once inference is possible.
    _load_engine()

    server = ThreadingHTTPServer((args.host, args.port), _Handler)
    print(f"[indextts] serving http://{args.host}:{args.port} engine={_ENGINE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[indextts] shutting down", flush=True)


if __name__ == "__main__":
    main()
