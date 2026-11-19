/* ==========================================================================
   CLOUDFLARE PAGES FUNCTION: /api/tts (STRICT COMPLETE AUDIO + AUTO-RETRY)
   ========================================================================== */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-130.0.2849.68';

const ALLOWED_VOICES = new Set([
  'bn-IN-BashkarNeural',
  'bn-BD-PradeepNeural',
  'bn-IN-TanishaaNeural',
  'bn-BD-NabanitaNeural'
]);

async function generateSecMsGec() {
  const unixSec = BigInt(Math.floor(Date.now() / 1000));
  let ticks = unixSec + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const payload = `${ticks}${TRUSTED_CLIENT_TOKEN}`;
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function makeUuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesizeOnce(text, voice, rate, pitch) {
  const connId = makeUuid();
  const reqId = makeUuid();
  const secMsGec = await generateSecMsGec();
  const lang = voice.startsWith('bn-BD') ? 'bn-BD' : 'bn-IN';

  const wsUrl =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connId}`;

  const resp = await fetch(wsUrl, {
    headers: {
      'Upgrade': 'websocket',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const ws = resp.webSocket;
  if (!ws) throw new Error(`Edge TTS WebSocket failed (HTTP ${resp.status})`);
  ws.accept();

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let gotTurnEnd = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (err) return reject(err);
      if (!gotTurnEnd) return reject(new Error('Audio stream truncated before turn.end'));
      const total = chunks.reduce((s, c) => s + c.length, 0);
      if (total < 600) return reject(new Error('Incomplete audio received'));
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      resolve(merged);
    };

    const timer = setTimeout(() => finish(new Error('TTS timeout')), 12000);

    ws.addEventListener('message', (event) => {
      try {
        if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.end')) {
            gotTurnEnd = true;
            finish(null);
          }
        } else if (event.data instanceof ArrayBuffer) {
          const buf = new Uint8Array(event.data);
          if (buf.length > 2) {
            const headerLen = new DataView(event.data).getUint16(0, false);
            const headerEnd = 2 + headerLen;
            if (buf.length > headerEnd) {
              const headerText = new TextDecoder().decode(buf.subarray(2, headerEnd));
              if (headerText.includes('Path:audio')) {
                chunks.push(buf.slice(headerEnd));
              }
            }
          }
        }
      } catch (e) {
        finish(e);
      }
    });

    ws.addEventListener('error', () => finish(new Error('WebSocket error')));
    ws.addEventListener('close', () => {
      if (!settled) finish(new Error('WebSocket closed before completion'));
    });

    const ts = new Date().toUTCString();
    const configMsg =
      `X-Timestamp:${ts}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

    const ssmlMsg =
      `X-RequestId:${reqId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${ts}\r\n` +
      `Path:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
      `<voice name='${voice}'>` +
      `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody>` +
      `</voice></speak>`;

    ws.send(configMsg);
    ws.send(ssmlMsg);
  });
}

async function synthesizeWithRetry(text, voice, rate, pitch) {
  try {
    return await synthesizeOnce(text, voice, rate, pitch);
  } catch (firstErr) {
    /* মাঝপথে কানেকশন কাটলে সাথে সাথে দ্বিতীয়বার চেষ্টা করে সম্পূর্ণ অডিও আনা */
    return await synthesizeOnce(text, voice, rate, pitch);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const rawText = (url.searchParams.get('text') || '').trim().slice(0, 450);
  if (!rawText) return new Response('Missing text parameter', { status: 400 });

  const reqVoice = url.searchParams.get('voice') || 'bn-IN-BashkarNeural';
  const voice = ALLOWED_VOICES.has(reqVoice) ? reqVoice : 'bn-IN-BashkarNeural';

  const rawRate = (url.searchParams.get('rate') || '+0%').trim();
  const rate = /^[+-]?\d{1,2}%$/.test(rawRate) ? (rawRate.startsWith('+') || rawRate.startsWith('-') ? rawRate : '+' + rawRate) : '+0%';

  const rawPitch = (url.searchParams.get('pitch') || '+0Hz').trim();
  const pitch = /^[+-]?\d{1,2}Hz$/.test(rawPitch) ? (rawPitch.startsWith('+') || rawPitch.startsWith('-') ? rawPitch : '+' + rawPitch) : '+0Hz';

  try {
    const mp3Bytes = await synthesizeWithRetry(rawText, voice, rate, pitch);
    return new Response(mp3Bytes, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'TTS failed' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}