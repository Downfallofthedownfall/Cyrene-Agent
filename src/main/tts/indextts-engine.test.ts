import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { synthesize } from "./indextts-engine";

let refAudioPath: string;

beforeEach(() => {
  refAudioPath = path.join(
    os.tmpdir(),
    `indextts-ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );
  fs.writeFileSync(refAudioPath, Buffer.from("RIFFfakeaudio"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { fs.rmSync(refAudioPath, { force: true }); } catch { /* ignore */ }
});

describe("indextts-engine synthesize 输入校验", () => {
  it("缺 baseUrl 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "",
      refAudioPath,
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/API 地址/);
  });

  it("缺 refAudioPath 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "",
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/参考音频/);
  });

  it("缺 promptText 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/nonexistent.wav",
      promptText: "",
      text: "hello",
    })).rejects.toThrow(/参考音频.*文本|参考文本/);
  });

  it("缺 text 时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/nonexistent.wav",
      promptText: "hi",
      text: "",
    })).rejects.toThrow(/合成文本|text/);
  });

  it("参考音频文件不存在时抛错", async () => {
    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath: "C:/definitely-not-there.wav",
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/不存在|文件不存在/);
  });
});

describe("indextts-engine synthesize 响应解析", () => {
  it("POST 到 /tts 并携带 index-tts 风格 JSON", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(Buffer.from("RIFFok"), {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "你好",
      text: "hello world",
      lang: "en",
      format: "wav",
    });

    const request = fetchMock.mock.calls[0]?.[0] as string;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request).toBe("http://localhost:9880/tts");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      text: "hello world",
      ref_audio_path: refAudioPath,
      prompt_text: "你好",
      text_lang: "en",
      prompt_lang: "en",
      speed_factor: 1,
      media_type: "wav",
    });
  });

  it("解析原始音频字节响应", async () => {
    const audio = Buffer.from("RIFFfake");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    })));

    const result = await synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "hi",
      text: "hello",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("wav");
  });

  it("解析 JSON base64 响应（audio_base64 snake，带 format）", async () => {
    const audio = Buffer.from("RIFFjson");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      audio_base64: audio.toString("base64"),
      format: "wav",
    })));

    const result = await synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "hi",
      text: "hello",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("wav");
  });

  it("解析 JSON base64 响应（audioBase64 camel）", async () => {
    const audio = Buffer.from("ID3json");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      audioBase64: audio.toString("base64"),
      format: "mp3",
    })));

    const result = await synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "hi",
      text: "hello",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("mp3");
  });

  it("JSON 响应缺 audio_base64 时抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ format: "wav" })));

    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/audio_base64/);
  });

  it("非 OK 时报错并带响应预览", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));

    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/400 bad request/);
  });

  it("AbortError（超时）时报超时错误", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortErr; }));

    await expect(synthesize({
      baseUrl: "http://localhost:9880",
      refAudioPath,
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/超时/);
  });
});

describe("indextts-engine synthesize baseUrl 解析（auto-launch）", () => {
  it("baseUrl 缺省时调用 resolveBaseUrl() 并用其结果请求", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(Buffer.from("RIFFok"), {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const resolveBaseUrl = vi.fn(async () => "http://127.0.0.1:9999");

    await synthesize({
      resolveBaseUrl,
      refAudioPath,
      promptText: "你好",
      text: "hello",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9999/tts");
    expect(resolveBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("baseUrl 与 resolveBaseUrl 同时提供时优先用 baseUrl（手动 server 覆盖）", async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from("RIFFok"), {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const resolveBaseUrl = vi.fn(async () => "http://auto:8888");

    await synthesize({
      baseUrl: "http://manual:7777",
      resolveBaseUrl,
      refAudioPath,
      promptText: "hi",
      text: "hello",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://manual:7777/tts");
    expect(resolveBaseUrl).not.toHaveBeenCalled();
  });

  it("baseUrl 与 resolveBaseUrl 都缺省时报缺地址错", async () => {
    await expect(synthesize({
      refAudioPath,
      promptText: "hi",
      text: "hello",
    })).rejects.toThrow(/API 地址/);
  });
});
