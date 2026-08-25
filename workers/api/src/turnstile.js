export const TURNSTILE_ALWAYS_PASS_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_ALWAYS_PASS_SECRET_KEY = "1x0000000000000000000000000000000AA";
export const TURNSTILE_ALWAYS_BLOCK_SITE_KEY = "2x00000000000000000000AB";
export const TURNSTILE_ALWAYS_BLOCK_SECRET_KEY = "2x0000000000000000000000000000000AA";

/** Verify through Cloudflare's siteverify endpoint in every environment. */
export async function verifyTurnstile(token, ip, env) {
  if (typeof token !== "string" || token.length === 0 || !env?.TURNSTILE_SECRET_KEY) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    if (ip) body.set("remoteip", ip);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.success === true;
  } catch {
    return false;
  }
}
