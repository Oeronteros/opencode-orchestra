import { createServer } from "node:http"
export async function browserFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/failure") { response.writeHead(503, { "Content-Type": "text/plain" }); response.end("controlled failure"); return }
    if (request.url === "/login" && request.method === "POST") {
      response.writeHead(303, { "Set-Cookie": "orchestra_fixture_auth=fixture-user; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax", Location: "/" }); response.end(); return
    }
    const authenticated = request.headers.cookie?.includes("orchestra_fixture_auth=fixture-user")
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><html><head><title>Orchestra local fixture</title></head><body>
      <h1>Browser fixture</h1><p id="auth">${authenticated ? "signed-in" : "signed-out"}</p>
      <form method="POST" action="/login"><label>Test account <input name="account" value="fixture-user"></label><button>Sign in</button></form>
      <button id="diagnostic">Reproduce error</button><p id="storage"></p>
      <script>document.querySelector('#storage').textContent=localStorage.getItem('fixture-state')||'no-storage';
      localStorage.setItem('fixture-state','persistent-test-value'); sessionStorage.setItem('tab-only','not-required-after-restart');
      document.querySelector('#diagnostic').onclick=()=>{fetch('/failure').then(r=>console.error('fixture-network-status',r.status));setTimeout(()=>{throw new Error('controlled-fixture-js-error')},0)}</script>
      </body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable")
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}
