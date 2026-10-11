import { issueLoginChallenge, loginGuardResponse, loginSecurityHeaders } from "../../../../lib/query-login-guard.ts";

export async function POST(request: Request) {
  try {
    const { challenge, cookie } = await issueLoginChallenge(request);
    return Response.json({ ok: true, challenge }, { headers: { ...loginSecurityHeaders, "Set-Cookie": cookie } });
  } catch (error) { return loginGuardResponse(error); }
}
