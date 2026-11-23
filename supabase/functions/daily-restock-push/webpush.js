/* Minimal Web Push sender (RFC 8291 message encryption + RFC 8292 VAPID),
   using only WebCrypto so it runs on Supabase Edge (Deno) and in Node. */
const enc = new TextEncoder();
export const b64u = {
  enc(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
async function hmac(key, data) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }
const jwkFromRaw = (pub, d) => ({ kty: "EC", crv: "P-256", x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ...(d ? { d: b64u.enc(d) } : {}), ext: true });

/* Encrypt one message for one subscription. `test` lets the RFC example fix the random parts. */
export async function encrypt(plaintext, uaPublicB64, authB64, test) {
  const uaPub = b64u.dec(uaPublicB64), auth = b64u.dec(authB64);
  let asPub, asPriv;
  if (test) { asPub = b64u.dec(test.asPublic); asPriv = await crypto.subtle.importKey("jwk", jwkFromRaw(asPub, b64u.dec(test.asPrivate)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]); }
  else { const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]); asPriv = kp.privateKey; asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const salt = test ? b64u.dec(test.salt) : crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const body = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(body, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); /* record size 4096 */
  return { body: cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct), debug: test ? { ecdh, prkKey, ikm, prk, cek, nonce, ct } : null };
}

/* VAPID: signed token that proves the push comes from this app */
export async function vapidAuth(endpoint, vapid, nowSec) {
  const aud = new URL(endpoint).origin, now = nowSec ?? Math.floor(Date.now() / 1000);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: vapid.subject })));
  const pub = b64u.dec(vapid.publicKey);
  const key = await crypto.subtle.importKey("jwk", jwkFromRaw(pub, b64u.dec(vapid.privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

/* Send one notification. Returns {ok, status, gone} (gone = subscription no longer valid) */
export async function sendPush(sub, payload, vapid, fetcher = fetch) {
  const { body } = await encrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const r = await fetcher(sub.endpoint, {
    method: "POST",
    headers: { Authorization: await vapidAuth(sub.endpoint, vapid), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "43200", Urgency: "high" },
    body,
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410, detail: r.ok ? "" : (await r.text().catch(() => "")).slice(0, 200) };
}
