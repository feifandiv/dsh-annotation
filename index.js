/**
 * Host half of the annotation bundle.
 *
 * The capability is entirely browser-side: selection capture, highlight
 * painting and annotation storage live in `./client.js`, which the Harness
 * serves to the Web client. This Host entry exists because a bundle row must
 * resolve, and it deliberately registers nothing.
 */
export function apply() {}
