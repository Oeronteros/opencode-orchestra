// Deterministic browser smoke fixture. Run after build:plugin; no microphone or LLM calls.
import http from 'node:http'
import { startVoiceWeb } from '../dist/voice-web.js'

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Voice browser smoke</title>
<style>body{font:16px system-ui;padding:30px;background:#141917;color:#eee}button{padding:10px;margin:4px} [contenteditable]{padding:20px;border:1px solid #888;min-height:80px}output{display:block;white-space:pre-wrap;margin:15px}</style></head>
<body><h1>Voice browser smoke</h1><p>Deterministic audio; no microphone and no model calls.</p>
<button id="a">Session A</button><button id="b">Session B</button><button id="rerender">Rerender</button>
<main></main><output id="state"></output><output id="submitted">Submits: 0</output>
<script>
let count = 0; const drafts = {};
function mount() {
 document.querySelector('main').innerHTML = '<form><div data-component="prompt-input" role="textbox" aria-label="Prompt" contenteditable="true"></div><button data-action="prompt-submit" type="submit" disabled>Send</button></form>';
 const editor = document.querySelector('[contenteditable]'); editor.textContent = drafts[location.pathname] || '';
 const sync = () => { drafts[location.pathname] = editor.textContent; document.querySelector('#state').textContent = 'Input event state: ' + editor.textContent; document.querySelector('[type=submit]').disabled = !editor.textContent; };
 editor.addEventListener('input', sync); sync();
 document.querySelector('form').onsubmit = event => { event.preventDefault(); document.querySelector('#submitted').textContent = 'Submits: ' + ++count + '; text: ' + drafts[location.pathname]; };
}
for (const id of ['a','b']) document.getElementById(id).onclick = () => { history.pushState({}, '', '/project/session/' + id); mount(); };
document.getElementById('rerender').onclick = mount;
if (location.pathname === '/') history.replaceState({}, '', '/project/session/a');
mount();
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value: async () => ({getTracks: () => [{stop(){}}]})});
window.MediaRecorder = class {
 state = 'inactive'; start(){this.state='recording'}
 stop(){this.state='inactive'; const wav = new ArrayBuffer(32044), v = new DataView(wav); const text=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i))};
 text(0,'RIFF');v.setUint32(4,32036,true);text(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,32000,true);
 this.ondataavailable?.({data:new Blob([wav],{type:'audio/wav'})});this.onstop?.();}
};
</script></body></html>`
const upstream = http
  .createServer((req, res) => {
    if (req.url === '/session') {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify([
          { id: 'a', title: 'Session A' },
          { id: 'b', title: 'Session B' }
        ])
      )
      return
    }
    if (req.method === 'POST') {
      res.writeHead(204).end()
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end(html)
  })
  .listen(0, '127.0.0.1')
await new Promise((resolve) => upstream.once('listening', resolve))
const web = await startVoiceWeb({
  port: 4197,
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  transcribe: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return 'Проверь почему падают тесты авторизации'
  }
})
console.log(web.url)
process.on('SIGINT', () => {
  web.server.closeAllConnections()
  web.server.close()
  upstream.closeAllConnections()
  upstream.close()
})
