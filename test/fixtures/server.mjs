import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>`;

const basic = page(
  'Basic Fixture',
  `
  <h1 id="title">Basic Fixture</h1>
  <button id="btn" onclick="document.getElementById('out').textContent='clicked'">Click me</button>
  <div id="out">idle</div>
  <input id="name" placeholder="name">
  <input id="number" type="number" value="42">
  <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <textarea id="notes"></textarea>
  <a id="next" href="/page2">Next page</a>
  <my-widget></my-widget>
  <iframe id="frame" title="inner" srcdoc="<title>Inside</title><h1 id='inside'>Frame Inside</h1><button id='frame-btn'>Frame Button</button>"></iframe>
  <script>
    class MyWidget extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<button id="shadow-btn">Shadow Button</button><div id="shadow-out">shadow-idle</div>';
        this.shadowRoot.getElementById('shadow-btn').addEventListener('click', () => {
          this.shadowRoot.getElementById('shadow-out').textContent = 'shadow-clicked';
        });
      }
    }
    customElements.define('my-widget', MyWidget);
  </script>
  `,
);

const page2 = page(
  'Page Two',
  `<h1 id="title">Page Two</h1><a id="back" href="/basic">Back</a>`,
);

const form = page(
  'Form Fixture',
  `<form id="form" action="/submitted" method="get">
    <input id="q" name="q" value="">
    <select id="pick" name="pick"><option value="one">One</option><option value="two">Two</option></select>
    <button id="submit" type="submit">Submit</button>
  </form>`,
);

const dialog = page(
  'Dialog Fixture',
  `<button id="alert" onclick="alert('hello-dialog')">Alert</button>
   <button id="confirm" onclick="window.__confirmResult = confirm('sure?')">Confirm</button>
   <div id="result"></div>`,
);

const consolePage = page(
  'Console Fixture',
  `<div id="api">pending</div>
   <script>
     console.log('fixture-log', 42);
     console.error('fixture-error');
     fetch('/api/data').then((r) => r.json()).then((x) => {
       document.getElementById('api').textContent = x.value;
     });
   </script>`,
);

const slow = page(
  'Slow Fixture',
  `<div id="slow">waiting</div>
   <script>setTimeout(() => { document.getElementById('slow').textContent = 'done'; document.body.dataset.ready = '1'; }, 700);</script>`,
);

const upload = page(
  'Upload Fixture',
  `<input id="file" type="file"><div id="picked"></div>
   <script>document.getElementById('file').addEventListener('change', (e) => {
     document.getElementById('picked').textContent = e.target.files[0] ? e.target.files[0].name : '';
   });</script>`,
);

const download = page(
  'Download Fixture',
  `<a id="dl" href="/file.txt" download="fixture.txt">Download</a>`,
);

const tall = page(
  'Tall Fixture',
  `<div id="tall" style="height:20000px;background:linear-gradient(#fff,#000)"><h1 id="title">Tall Fixture</h1></div>`,
);

const leave = page(
  'Leave Fixture',
  `<h1 id="title">Leave Fixture</h1>
   <script>window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>`,
);

const unicode = page(
  'Unicode Fixture',
  `<h1 id="title">Unicode Fixture</h1><input id="text"><div id="out"></div>
   <script>document.getElementById('text').addEventListener('input', (e) => {
     document.getElementById('out').textContent = e.target.value + '|' + [...e.target.value].length;
   });</script>`,
);


const redirect = page('Redirect Fixture', `<a id="go" href="/redirect">Redirect</a>`);

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

export async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    switch (url.pathname) {
      case '/':
      case '/basic':
        return send(res, 200, 'text/html; charset=utf-8', basic);
      case '/page2':
        return send(res, 200, 'text/html; charset=utf-8', page2);
      case '/form':
        return send(res, 200, 'text/html; charset=utf-8', form);
      case '/submitted':
        return send(res, 200, 'text/html; charset=utf-8', page('Submitted', `<h1 id="title">Submitted</h1><p id="query">${url.search}</p>`));
      case '/dialog':
        return send(res, 200, 'text/html; charset=utf-8', dialog);
      case '/console':
        return send(res, 200, 'text/html; charset=utf-8', consolePage);
      case '/slow':
        return setTimeout(() => send(res, 200, 'text/html; charset=utf-8', slow), 500);
      case '/upload':
        return send(res, 200, 'text/html; charset=utf-8', upload);
      case '/download':
        return send(res, 200, 'text/html; charset=utf-8', download);
      case '/tall':
        return send(res, 200, 'text/html; charset=utf-8', tall);
      case '/leave':
        return send(res, 200, 'text/html; charset=utf-8', leave);
      case '/unicode':
        return send(res, 200, 'text/html; charset=utf-8', unicode);
      case '/slow-nav':
        return setTimeout(() => send(res, 200, 'text/html; charset=utf-8', page('Slow Nav', '<h1 id="title">Slow Nav</h1>')), 800);
      case '/redirect-page':
        return send(res, 200, 'text/html; charset=utf-8', redirect);
      case '/redirect':
        return send(res, 302, 'text/plain', '', { location: '/page2' });
      case '/api/data':
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, value: 'fixture-api' }));
      case '/file.txt':
        return send(res, 200, 'text/plain; charset=utf-8', 'download-fixture-content\n', {
          'content-disposition': 'attachment; filename="fixture.txt"',
        });
      case '/favicon.ico':
        res.writeHead(204);
        return res.end();
      case '/404':
        return send(res, 404, 'text/html; charset=utf-8', page('Not Found', '<h1>Not Found</h1>'));
      default:
        return send(res, 404, 'text/plain', 'not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFixtureServer();
  process.stdout.write(`PORT=${fixture.port}\n`);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
