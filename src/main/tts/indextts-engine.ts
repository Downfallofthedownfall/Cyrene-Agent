// IndexTTS 本地/云端 HTTP TTS 引擎（版本无关，兼容 IndexTTS 2.x）
// 接口：POST /tts（与 GPT-SoVITS 同构），返回 wav/mp3 原始字节，或 JSON { audio_base64, format }。
// 参考：https://github.com/index-tts/index-tts
// 注意：刻意不硬编码任何 2.5 专属字段，保持与 2.x 兼容；若某字段为版本相关，仅在选项提供时携带。
//
// 增强可用性（auto-launch）：默认指向 IndexTTS 2.0；当作为本地引擎使用时，
// 主进程会加载 bundled 的 thin server（src/main/tts/server/indextts_server.py）。
// 调用方只需在没有 baseUrl 时给 resolveBaseUrl()（如 src/main/tts/indextts-server.ts
// 的 resolveIndexttsBaseUrl），引擎就会拿到 runner 解析出的 baseUrl；
// 若调用方自己跑 server，则保持传入 baseUrl 覆盖即可。
import * as fs from "fs";
import { resolveTimeoutPolicy } from "../runtime-policy";

export interface IndexttsSynthesizeOptions {
  /** 手动 server 地址（形如 "http://localhost:9880"，不含路径）；用户自己跑 server 时用。 */
  baseUrl?: string;
  /** 未给 baseUrl 时的解析回调：用于 auto-launch（runner 返回的数据。如 127.0.0.1:<port>）。
   *  允许返回 string 或 Promise<string>，引擎统一 await。 */
  resolveBaseUrl?: () => string | Promise<string>;
  refAudioPath: string;     // 参考音频绝对路径
  promptText: string;       // 参考音频对应的文本
  text: string;             // 待合成文本
  speed?: number;           // 语速，默认 1
  lang?: string;            // 文本/参考音频语言（如 "zh"、"en"），默认由服务端决定
  format?: "wav" | "mp3";   // 请求的输出格式（media_type），默认 wav
  timeoutMs?: number;      // 默认由 ../runtime-policy 的 tts-indextts 阶段提供
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface IndexttsSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = resolveTimeoutPolicy({ stage: "tts-indextts" }).totalMs;
const TTS_PATH = "/tts";

function normalizeFormat(value: unknown, fallback: "wav" | "mp3"): "wav" | "mp3" {
  return value === "wav" || value === "mp3" ? value : fallback;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

/**
 * 调 IndexTTS 的 `/tts` 接口。
 * 请求体为 index-tts 风格 JSON（与 GPT-SoVITS 共用字段）：
 *   text / ref_audio_path / prompt_text / speed_factor（+ 可选 text_lang/prompt_lang/media_type）。
 * 返回完整 wav（或 mp3）字节；也兼容 JSON { audio_base64, format } 响应。
 */
export async function synthesize(opts: IndexttsSynthesizeOptions): Promise<IndexttsSynthesizeResult> {
  const format: "wav" | "mp3" = opts.format ?? "wav";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `indextts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  // 1) 解析 baseUrl：优先用调用方传入的（手动 server），否则用 resolveBaseUrl（auto-launch）。
  const baseUrl = opts.baseUrl ?? (opts.resolveBaseUrl ? await opts.resolveBaseUrl() : null);

  // 2) 输入校验
  if (!baseUrl) throw new Error("缺少 IndexTTS API 地址");
  if (!opts.refAudioPath) throw new Error("缺少参考音频路径");
  if (!opts.promptText) throw new Error("缺少参考音频对应的文本");
  if (!opts.text) throw new Error("缺少合成文本");
  if (!fs.existsSync(opts.refAudioPath)) {
    throw new Error(`参考音频文件不存在: ${opts.refAudioPath}`);
  }

  // 3) 构造 JSON body（裸对象，不包 data）。
  // 只带 IndexTTS 各版本都支持的通用字段；版本相关字段仅在选项提供时才追加，避免 2.5 专属参数写死。
  const bodyObj: Record<string, unknown> = {
    text: opts.text,
    ref_audio_path: opts.refAudioPath,
    prompt_text: opts.promptText,
    speed_factor: opts.speed ?? 1,
  };
  if (opts.lang) {
    bodyObj.text_lang = opts.lang;
    bodyObj.prompt_lang = opts.lang;
  }
  if (format) {
    bodyObj.media_type = format;
  }
  const body = JSON.stringify(bodyObj);

  // baseUrl 去掉尾部斜杠，拼 /tts
  const url = baseUrl.replace(/\/+$/, "") + TTS_PATH;

  log({
    phase: "request.begin",
    endpoint: url,
    textChars: Array.from(opts.text).length,
    refAudioPath: opts.refAudioPath,
    lang: opts.lang,
    format,
  });

  // 3) 发请求 + 超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log({ phase: "error", error: `合成超时（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`IndexTTS 合成超时（${timeoutMs}ms），检查服务是否在跑`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`IndexTTS 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  // 4) 响应处理
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const preview = text.slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`IndexTTS 合成失败: ${resp.status} ${preview}`.trim());
  }

  const contentType = resp.headers.get("Content-Type") ?? "";
  let audio: Buffer;
  let resultFormat = format;

  if (isJsonContentType(contentType)) {
    const data = (await resp.json()) as {
      audio_base64?: unknown;
      audioBase64?: unknown;
      format?: unknown;
    };
    const base64 = typeof data.audio_base64 === "string" && data.audio_base64
      ? data.audio_base64
      : typeof data.audioBase64 === "string"
        ? data.audioBase64
        : null;
    if (!base64) {
      throw new Error("IndexTTS 响应缺少 audio_base64");
    }
    audio = Buffer.from(base64, "base64");
    resultFormat = normalizeFormat(data.format, format);
  } else {
    audio = Buffer.from(await resp.arrayBuffer());
  }

  if (audio.length === 0) {
    log({ phase: "warn", message: "返回空音频", contentType });
  }

  log({
    phase: "response.final",
    durationMs: Date.now() - startedAt,
    audioBytes: audio.length,
    format: resultFormat,
  });

  return { audio, format: resultFormat };
}
