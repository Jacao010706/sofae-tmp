// Player de vídeo do Sofae: HLS.js para .m3u8 e <video> nativo para MP4/MKV.
//
// Estratégia de rede (tentativas em ordem):
//  1. Servidor HTTPS: direto (sem passar por proxy).
//  2. Proxy do VPS (https://proxy.sofae.com.br): muitos servidores IPTV
//     bloqueiam os IPs da Vercel, e o VPS não tem limite de duração de stream.
//  3. Proxy da Vercel (/api/proxy): reserva, caso o VPS esteja fora do ar.
import { proxyUrl } from './api.js';

export const STREAM_PROXY = 'https://proxy.sofae.com.br/stream';

function vpsProxyUrl(url, extra = {}) {
  const p = new URLSearchParams({ url });
  if (extra.mac) p.set('mac', extra.mac);
  return `${STREAM_PROXY}?${p.toString()}`;
}

const isHls = (url) => {
  const u = new URL(url);
  return /\.m3u8?$/i.test(u.pathname) || /extension=m3u8/i.test(u.search);
};

export class Player {
  constructor(video, { onError, onStatus } = {}) {
    this.video = video;
    this.hls = null;
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this._token = 0;
  }

  destroy() {
    this._token++;
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  play(url, proxyExtra = {}) {
    this.destroy();
    const token = this._token;
    const secure = url.startsWith('https://') || location.protocol === 'http:';
    const proxied = [vpsProxyUrl(url, proxyExtra), proxyUrl(url, proxyExtra)];
    const attempts = secure ? [url, ...proxied] : proxied;
    const hls = isHls(url);
    this._try(attempts, 0, hls, token);
  }

  _try(attempts, i, hls, token) {
    if (token !== this._token) return;
    if (i >= attempts.length) {
      this.onError('Não foi possível reproduzir este conteúdo. Verifique se ele está disponível no seu servidor.');
      return;
    }
    const src = attempts[i];
    const label = src.startsWith('https://proxy') ? 'VPS' : src.startsWith('/api/') ? 'Vercel' : 'direto';
    console.log(`[Player] tentativa ${i + 1}/${attempts.length} (${label}):`, src.split('?')[0]);
    const next = () => this._try(attempts, i + 1, hls, token);
    this.onStatus('Carregando…');

    if (hls && window.Hls && window.Hls.isSupported()) {
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      const h = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
      });
      this.hls = h;
      let started = false;
      h.on(window.Hls.Events.MANIFEST_PARSED, () => {
        started = true;
        console.log(`[Player] manifest OK (${label})`);
        this.onStatus('');
        this.video.play().catch(() => {});
      });
      h.on(window.Hls.Events.ERROR, (_e, data) => {
        if (token !== this._token || !data.fatal) return;
        console.warn(`[Player] erro fatal (${label}, started=${started}):`, data.type, data.details);
        h.destroy(); this.hls = null;
        if (!started || i + 1 < attempts.length) { next(); return; }
        this.onError('A reprodução foi interrompida.');
      });
      h.loadSource(src);
      h.attachMedia(this.video);
      return;
    }

    // Safari/iPad (HLS nativo) ou arquivos MP4/MKV
    const v = this.video;
    const cleanup = () => {
      v.removeEventListener('loadedmetadata', ok);
      v.removeEventListener('error', fail);
    };
    const ok = () => { cleanup(); if (token === this._token) { this.onStatus(''); v.play().catch(() => {}); } };
    const fail = () => { cleanup(); if (token === this._token) next(); };
    v.addEventListener('loadedmetadata', ok);
    v.addEventListener('error', fail);
    v.src = src;
    v.load();
  }
}
