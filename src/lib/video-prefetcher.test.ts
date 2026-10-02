import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWindow, indexAtTime, VideoPrefetcher } from './video-prefetcher';
import { clearVideoCache } from './video-cache';

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await clearVideoCache();
});

describe('computeWindow', () => {
  const durations = [4, 4, 4, 4, 4]; // 总长 20s

  it('indexAtTime：累计时长定位分片', () => {
    expect(indexAtTime(durations, 0)).toBe(0);
    expect(indexAtTime(durations, 4.5)).toBe(1);
    expect(indexAtTime(durations, 100)).toBe(4);
  });

  it('有限窗口：从回看点到当前 + horizon', () => {
    // 当前 10s，回看 5s → from 覆盖 5s 处；horizon 6s → to 覆盖 16s 处
    const { fromIdx, toIdx } = computeWindow(durations, 10, 6, 5);
    expect(fromIdx).toBe(1); // 5s 落在第 2 片
    expect(toIdx).toBe(4);   // 16s 落在第 4 片末
  });

  it('horizon = 0：无限铺满到片尾', () => {
    const { fromIdx, toIdx } = computeWindow(durations, 10, 0, 5);
    expect(fromIdx).toBe(1);
    expect(toIdx).toBe(5);
  });

  it('锚点接近片尾时钳制', () => {
    const { fromIdx, toIdx } = computeWindow(durations, 19, 6, 5);
    expect(toIdx).toBe(5);
  });

  it('时长全缺失时按数量兜底', () => {
    const { toIdx } = computeWindow([0, 0, 0, 0, 0, 0], 0, 6, 5);
    expect(toIdx).toBeLessThanOrEqual(6);
  });
});

describe('VideoPrefetcher.ensure 幂等', () => {
  const PLAYLIST = [
    '#EXTM3U',
    '#EXTINF:5,',
    'https://cdn.example.com/seg1.ts',
    '#EXTINF:5,',
    'https://cdn.example.com/seg2.ts',
  ].join('\n');

  const M3U8_URL = 'https://cdn.example.com/index.m3u8';

  function makePrefetcher() {
    const m3u8Fetches = vi.fn();
    // 首次 m3u8 拉取可挂起（模拟 parsing 中途的第二次 ensure），其余立即返回
    let gated = true;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('index.m3u8')) {
        m3u8Fetches();
        if (gated) {
          gated = false;
          return new Promise<Response>((r) => setTimeout(() => r(new Response(PLAYLIST, { status: 200 })), 50));
        }
        return Promise.resolve(new Response(PLAYLIST, { status: 200 }));
      }
      return Promise.resolve(new Response(new ArrayBuffer(1000), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return { m3u8Fetches };
  }

  it('parsing 期间同 descriptor 的第二次 ensure 不 abort 刚起跑的运行', async () => {
    const { m3u8Fetches } = makePrefetcher();
    const p = new VideoPrefetcher();

    p.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:0', horizonSeconds: 10 });
    // 解析尚未完成（fetch 挂起）时的第二次 ensure：同 descriptor，不得重建
    p.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:0', horizonSeconds: 10 });
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(p.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);
  });

  it('done 状态的重复 ensure 按设计重建；换集必重建', async () => {
    const { m3u8Fetches } = makePrefetcher();
    const p = new VideoPrefetcher();

    p.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:0', horizonSeconds: 10 });
    await vi.waitFor(() => expect(p.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(1);

    // done 后的 ensure 会重查覆盖并重建（分片已缓存的拉取在 loader 侧命中）
    p.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:0', horizonSeconds: 10 });
    await vi.waitFor(() => expect(p.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(2);

    // 换集：descriptor 不同 → 必须重建
    p.ensure({ m3u8Url: M3U8_URL, currentTime: 0, episodeKey: 's:v:1', horizonSeconds: 10 });
    await vi.waitFor(() => expect(p.getStats().state).toBe('done'));
    expect(m3u8Fetches).toHaveBeenCalledTimes(3);
  });
});
