/**
 * Refuse every TLS chain that contains a key known to be compromised, on every
 * outbound connection this process makes (the Gemini and OpenAI clients
 * included).
 *
 * Node trusts its own bundled roots, not the system's, and has no way to
 * distrust an intermediate. In the eMudhra incident (October 2026, eight
 * intermediate keys compromised, https://emudhra.we-have-a-problem.com/) Node
 * kept accepting certificates those keys issue for any host after browsers,
 * Go and the Linux distributions had blocked them, and Node 20 gets no fix.
 * Node's default `tls.checkServerIdentity` runs after chain verification on
 * every connection that does not pass its own, and Node reads it from the
 * module at connect time, so replacing it covers `fetch` too.
 *
 * The check matches keys, not certificates: each intermediate also has a
 * Sectigo cross-sign with the same key. Values are the SHA-256 of the DER
 * SubjectPublicKeyInfo (`spki_sha256` in the incident's
 * impacted-intermediates.json). Same list as Iris's src/server/tls-distrust.ts.
 */
import tls from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';

const COMPROMISED_KEYS: ReadonlyMap<string, string> = new Map([
  ['EBED6475C2C2D80FCB199F3FE8DD6E6B3CE60B77EB15D4E42C3DEC0C6F5B5105', 'EM DV TLS CA - G3B'],
  ['43BFFA19D6EF651451F6841E019931E96F6F2EAEFF28AB4B6F1CE4576DE2717B', 'EM OV TLS CA - G3B'],
  ['E0254C7FCDC265E2F0F8A428DABB75AB4AE039B4872D62F5EE57F0877D5A8A41', 'EM EV TLS CA - G3B'],
  ['49DD353DC2B919A3770645117D0E60C16115E7D1BC259EEFE734B00EA434FE5F', 'EM DV TLS CA - G3C'],
  ['63ECEFEE431D49523BC1136C4E72D0206A477086CAF606CD5CF025686C109CF8', 'EM OV TLS CA - G3C'],
  ['5C0660A2B164910D8FF589C18E14552E9E0EC237DCEFE2CB736D41A4811F81A0', 'EM EV TLS CA - G3C'],
  ['EC4FFA1AD0AC88081314B7AAFFEF6A91F97CD57291BB5BA686C5415F5EB4F6B6', 'EM OV CS CA - G3B'],
  ['92C063D67E8F14DB71D288E11266FFDAF69CBF115F7BAB14F3BC2F68D25E0E30', 'EM OV CS CA - G3C'],
]);

/** The name of the first compromised key in the chain, or null. */
function compromisedKeyIn(cert: tls.DetailedPeerCertificate): string | null {
  const seen = new Set<tls.PeerCertificate>();
  // A self-signed root is its own issuerCertificate.
  for (let c: tls.DetailedPeerCertificate | undefined = cert; c?.raw && !seen.has(c); c = c.issuerCertificate) {
    seen.add(c);
    const spki = new X509Certificate(c.raw).publicKey.export({ type: 'spki', format: 'der' });
    const name = COMPROMISED_KEYS.get(createHash('sha256').update(spki).digest('hex').toUpperCase());
    if (name) return name;
  }
  return null;
}

const defaultCheck = tls.checkServerIdentity;
tls.checkServerIdentity = (host, cert) => {
  let reason: string;
  try {
    const name = compromisedKeyIn(cert as tls.DetailedPeerCertificate);
    if (!name) return defaultCheck(host, cert);
    reason = `its chain contains the compromised key of "${name}"`;
  } catch (e) {
    // A throw here would escape the socket's handshake handler and end the
    // process; refusing the one connection is the safe outcome.
    reason = `its chain could not be checked for compromised keys (${(e as Error).message})`;
  }
  console.warn(`[TLS] refused ${host}: ${reason}`);
  return Object.assign(new Error(`${host}: ${reason}`), { code: 'ERR_TLS_CERT_DISTRUSTED' });
};
