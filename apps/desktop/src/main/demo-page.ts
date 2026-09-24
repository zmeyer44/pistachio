export function demoPortalHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <title>Northstar · Invoice reconciliation</title>
    <style>
      :root { color-scheme: light; --ink:#17201b; --muted:#6f786f; --line:#d9ddd6; --paper:#f8f8f3; --pista:#b8e98f; --deep:#224332; }
      * { box-sizing: border-box; }
      body { margin:0; min-height:100vh; color:var(--ink); background:var(--paper); font:14px/1.45 "Avenir Next", Avenir, sans-serif; }
      header { height:72px; display:flex; align-items:center; justify-content:space-between; padding:0 34px; border-bottom:1px solid var(--line); background:#fff; }
      .brand { display:flex; align-items:center; gap:13px; font-weight:700; letter-spacing:-.02em; }
      .mark { width:29px; height:29px; border-radius:9px 9px 12px 9px; background:var(--deep); position:relative; transform:rotate(-4deg); }
      .mark:after { content:""; position:absolute; width:9px; height:9px; border-radius:50%; background:var(--pista); right:5px; top:5px; }
      .signed { display:flex; align-items:center; gap:8px; color:#455047; font-size:12px; }
      .signed i { width:7px; height:7px; border-radius:50%; background:#42a36a; box-shadow:0 0 0 4px #e5f5e9; }
      main { max-width:1040px; margin:0 auto; padding:38px 34px 70px; }
      .eyebrow { color:#637168; font:600 11px/1 "SFMono-Regular", ui-monospace, monospace; text-transform:uppercase; letter-spacing:.13em; }
      h1 { margin:9px 0 8px; font-family:"Iowan Old Style", Georgia, serif; font-size:40px; font-weight:500; letter-spacing:-.035em; }
      .lead { color:var(--muted); max-width:630px; margin:0 0 30px; }
      .grid { display:grid; grid-template-columns:1.25fr .75fr; gap:20px; }
      .card { background:#fff; border:1px solid var(--line); border-radius:18px; box-shadow:0 12px 35px rgba(30,45,35,.06); overflow:hidden; }
      .card-title { display:flex; align-items:center; justify-content:space-between; padding:18px 21px; border-bottom:1px solid var(--line); }
      .badge { padding:5px 9px; border-radius:999px; background:#edf1ec; color:#4b584f; font-size:11px; font-weight:650; }
      form { padding:22px; display:grid; grid-template-columns:1fr 1fr; gap:17px; }
      label { display:grid; gap:7px; color:#677068; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
      label.full { grid-column:1/-1; }
      input, select, textarea { width:100%; border:1px solid #ccd2ca; border-radius:10px; padding:11px 12px; color:var(--ink); background:#fbfcf9; font:500 14px "Avenir Next", Avenir, sans-serif; outline:none; }
      input:focus, select:focus, textarea:focus { border-color:#638e68; box-shadow:0 0 0 3px rgba(99,142,104,.13); }
      textarea { min-height:88px; resize:vertical; }
      .totals { margin:0 22px 22px; padding:16px; border-radius:12px; background:#f1f4ef; display:grid; gap:9px; }
      .total { display:flex; justify-content:space-between; }
      .total strong { font-size:18px; }
      button { grid-column:1/-1; border:0; border-radius:11px; padding:13px 16px; color:white; background:var(--deep); font-weight:750; cursor:pointer; transition:transform .14s ease, background .14s ease; }
      button:hover { background:#2e5a43; transform:translateY(-1px); }
      .history { padding:5px 20px 19px; }
      .event { display:grid; grid-template-columns:12px 1fr; gap:10px; padding:13px 0; border-bottom:1px solid #edf0eb; }
      .event:last-child { border-bottom:0; }
      .dot { width:8px; height:8px; margin-top:5px; border-radius:50%; background:#b0bbb1; }
      .event:first-child .dot { background:#65a16c; }
      .event b { display:block; font-size:13px; }
      .event small { color:var(--muted); }
      .vendor-link { display:inline-flex; align-items:center; gap:5px; color:var(--deep); font-weight:700; text-decoration:none; }
      .vendor-link:hover { text-decoration:underline; text-underline-offset:3px; }
      button.vendor-link { border:0; background:none; padding:0; font:inherit; cursor:pointer; }
      #result { display:none; margin:0 22px 22px; padding:15px 16px; border-radius:12px; color:#21482f; background:#e7f7e9; border:1px solid #b9dec0; }
      body[data-agent="working"] .card:first-child { outline:3px solid rgba(184,233,143,.45); }
      @media (max-width:760px) { .grid { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <header>
      <div class="brand"><span class="mark"></span>Northstar Finance</div>
      <div class="signed"><i></i>Signed in as Avery Chen</div>
    </header>
    <main>
      <div class="eyebrow">Accounts payable / Review queue</div>
      <h1>Reconcile invoice #NS-2048</h1>
      <p class="lead">Match the vendor invoice to the purchase order, document the variance, and submit the reconciliation for payment.</p>
      <div class="grid">
        <section class="card">
          <div class="card-title"><strong>Reconciliation</strong><span class="badge" id="status-badge">Draft</span></div>
          <form id="reconcile-form">
            <input type="hidden" name="csrfToken" value="page-default-token" />
            <input type="password" name="accountPassword" value="" hidden />
            <label>Vendor<select name="vendor"><option>Atlas Medical Supply</option></select></label>
            <label>Purchase order<input name="purchaseOrder" value="PO-93841" /></label>
            <label>Invoice total<input name="invoiceTotal" value="$8,420.00" /></label>
            <label>PO total<input name="poTotal" value="$8,400.00" /></label>
            <label class="full">Reconciliation note<textarea id="memo" name="memo" placeholder="Explain the variance before submitting"></textarea></label>
            <button type="submit" id="submit-reconciliation">Submit reconciliation</button>
          </form>
          <div id="result"><strong>Reconciliation submitted.</strong> The $20 freight variance was documented and routed for payment.</div>
        </section>
        <aside class="card">
          <div class="card-title"><strong>Evidence</strong><span class="badge">2 documents</span></div>
          <div class="totals"><div class="total"><span>Subtotal</span><span>$8,000.00</span></div><div class="total"><span>Freight</span><span>$420.00</span></div><div class="total"><strong>Total</strong><strong>$8,420.00</strong></div></div>
          <div class="history">
            <div class="event"><span class="dot"></span><div><b><a id="vendor-record-link" class="vendor-link" href="pistachio://demo/vendors/atlas-medical" target="_blank" rel="noopener">Atlas Medical Supply <span aria-hidden="true">↗</span></a></b><small>Invoice received today at 9:14 AM · PDF</small></div></div>
            <div class="event"><span class="dot"></span><div><b><button type="button" id="vendor-record-open" class="vendor-link">Vendor record <span aria-hidden="true">↗</span></button></b><small>Opens from script, not a link</small></div></div>
            <div class="event"><span class="dot"></span><div><b>PO matched</b><small>99.8% match · $20 variance</small></div></div>
            <div class="event"><span class="dot"></span><div><b>Awaiting review</b><small>Submission changes financial state</small></div></div>
          </div>
        </aside>
      </div>
    </main>
    <script>
      document.querySelector('#vendor-record-open').addEventListener('click', () => {
        window.open('pistachio://demo/vendors/atlas-medical', '_blank');
      });
      document.querySelector('#reconcile-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        document.body.dataset.submitResult = 'pending';
        try {
          const response = await fetch('pistachio://demo/api/invoices/NS-2048/reconciliation/submit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ memo: document.querySelector('#memo').value }),
          });
          if (!response.ok) throw new Error('submission rejected');
          document.querySelector('#status-badge').textContent = 'Submitted';
          document.querySelector('#result').style.display = 'block';
          document.querySelector('#reconcile-form').style.display = 'none';
          document.body.dataset.agent = 'complete';
          document.body.dataset.submitResult = 'completed';
          localStorage.setItem('pistachio-demo-submitted', new Date().toISOString());
        } catch {
          document.body.dataset.submitResult = 'blocked';
        }
      });
    </script>
  </body>
</html>`;
}

let toneWav: ArrayBuffer | null = null;

/** Offline media fixture used by the browser's playback-control E2E. */
export function demoToneWav(): ArrayBuffer {
  if (toneWav !== null) return toneWav;
  const sampleRate = 8_000;
  const samples = sampleRate * 8;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 400) * Math.min(1, (samples - index) / 400);
    view.setInt16(44 + index * 2, Math.sin(index / sampleRate * Math.PI * 2 * 220) * 2_400 * envelope, true);
  }
  toneWav = bytes;
  return toneWav;
}

/** A second authenticated-looking page used to exercise Glance locally. */
export function demoVendorHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; img-src 'self' pistachio: data:; style-src 'unsafe-inline'" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23224332'/%3E%3Ctext x='32' y='42' text-anchor='middle' font-size='30' font-family='serif' font-weight='700' fill='white'%3EA%3C/text%3E%3C/svg%3E" />
    <title>Atlas Medical Supply · Vendor record</title>
    <style>
      :root { color-scheme:light; --ink:#17201b; --muted:#6f786f; --line:#d9ddd6; --paper:#f8f8f3; --pista:#b8e98f; --deep:#224332; }
      * { box-sizing:border-box; }
      body { margin:0; min-height:100vh; color:var(--ink); background:var(--paper); font:14px/1.45 "Avenir Next", Avenir, sans-serif; }
      header { height:72px; display:flex; align-items:center; justify-content:space-between; padding:0 34px; border-bottom:1px solid var(--line); background:#fff; }
      .brand { display:flex; align-items:center; gap:13px; font-weight:700; letter-spacing:-.02em; }
      .mark { width:29px; height:29px; border-radius:9px 9px 12px 9px; background:var(--deep); position:relative; transform:rotate(-4deg); }
      .mark:after { content:""; position:absolute; width:9px; height:9px; border-radius:50%; background:var(--pista); right:5px; top:5px; }
      .crumb { color:var(--muted); font-size:12px; }
      main { max-width:900px; margin:0 auto; padding:44px 34px 70px; }
      .eyebrow { color:#637168; font:600 11px/1 "SFMono-Regular", ui-monospace, monospace; text-transform:uppercase; letter-spacing:.13em; }
      .hero { display:flex; align-items:center; gap:18px; margin:15px 0 34px; }
      .avatar { display:grid; width:62px; height:62px; place-items:center; border-radius:18px; color:#fff; background:var(--deep); font:600 23px Georgia, serif; box-shadow:0 10px 24px rgba(34,67,50,.18); }
      h1 { margin:0 0 4px; font:500 38px/1.1 "Iowan Old Style", Georgia, serif; letter-spacing:-.035em; }
      .verified { color:#3b7650; font-size:12px; font-weight:700; }
      .grid { display:grid; grid-template-columns:1.1fr .9fr; gap:18px; }
      .card { background:#fff; border:1px solid var(--line); border-radius:18px; box-shadow:0 12px 35px rgba(30,45,35,.06); overflow:hidden; }
      .card h2 { margin:0; padding:17px 20px; border-bottom:1px solid var(--line); font-size:14px; }
      dl { display:grid; grid-template-columns:130px 1fr; gap:14px 18px; margin:0; padding:22px; }
      dt { color:var(--muted); } dd { margin:0; font-weight:650; }
      .metric { padding:20px; border-bottom:1px solid #edf0eb; }
      .metric:last-child { border-bottom:0; }
      .metric strong { display:block; font:600 25px/1.2 Georgia, serif; }
      .metric span { color:var(--muted); font-size:12px; }
      @media (max-width:680px) { .grid { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <header><div class="brand"><span class="mark"></span>Northstar Finance</div><div class="crumb">Vendors / Active</div></header>
    <main>
      <div class="eyebrow">Verified vendor · V-0194</div>
      <div class="hero"><div class="avatar">AM</div><div><h1>Atlas Medical Supply</h1><div class="verified">● Banking details verified 18 days ago</div></div></div>
      <div class="grid">
        <section class="card"><h2>Vendor profile</h2><dl><dt>Category</dt><dd>Clinical supplies</dd><dt>Payment terms</dt><dd>Net 30</dd><dt>Primary contact</dt><dd>Maya Ortiz</dd><dt>Tax status</dt><dd>W-9 on file</dd><dt>Risk review</dt><dd>Low risk</dd></dl></section>
        <aside class="card"><h2>Relationship</h2><div class="metric"><strong>$184,260</strong><span>Paid in the last 12 months</span></div><div class="metric"><strong>14</strong><span>Matched invoices</span></div><div class="metric"><strong>99.4%</strong><span>Average PO match</span></div></aside>
      </div>
    </main>
  </body>
</html>`;
}

/** Offline relying-party fixture for real child-window OAuth behavior. */
export function demoAuthRelyingPartyHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <title>Connected accounts · Pistachio</title>
    <style>
      :root { color-scheme:light; --ink:#17201b; --muted:#6f786f; --line:#d9ddd6; --paper:#f8f8f3; --green:#224332; --pista:#b8e98f; }
      * { box-sizing:border-box; }
      body { margin:0; min-height:100vh; color:var(--ink); background:linear-gradient(135deg,#f8f8f3,#eef4e9); font:14px/1.45 "Avenir Next",Avenir,sans-serif; }
      header { height:72px; display:flex; align-items:center; justify-content:space-between; padding:0 34px; border-bottom:1px solid var(--line); background:rgba(255,255,255,.86); }
      .brand { font-weight:750; letter-spacing:-.02em; } .secure { color:#3b7650; font-size:12px; font-weight:700; }
      main { max-width:860px; margin:0 auto; padding:58px 34px; }
      .eyebrow { color:#637168; font:600 11px/1 ui-monospace,monospace; text-transform:uppercase; letter-spacing:.13em; }
      h1 { margin:11px 0 8px; font:500 42px/1.08 "Iowan Old Style",Georgia,serif; letter-spacing:-.04em; }
      .lead { max-width:600px; margin:0 0 30px; color:var(--muted); }
      .grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
      .card { padding:23px; border:1px solid var(--line); border-radius:18px; background:#fff; box-shadow:0 14px 36px rgba(30,45,35,.07); }
      .site { display:flex; align-items:center; gap:10px; margin-bottom:12px; font-weight:750; }
      .logo { display:grid; width:34px; height:34px; place-items:center; border-radius:10px; color:white; background:var(--green); font:700 16px Georgia,serif; }
      .status { min-height:22px; margin:14px 0 18px; color:var(--muted); font-size:12px; }
      .status[data-connected="true"] { color:#2f7547; font-weight:750; }
      a,button { display:flex; width:100%; align-items:center; justify-content:center; border:0; border-radius:11px; padding:12px 14px; color:white; background:var(--green); font:750 13px "Avenir Next",Avenir,sans-serif; text-decoration:none; cursor:pointer; }
      a:hover,button:hover { background:#2f5d46; }
      @media (max-width:680px) { .grid { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <header><div class="brand">Pistachio identity lab</div><div class="secure">● Same-Space session</div></header>
    <main>
      <div class="eyebrow">Authentication handoff</div>
      <h1>Connected accounts</h1>
      <p class="lead">These local fixtures exercise the two browser behaviors used by YouTube and X without sending credentials to an external service.</p>
      <div class="grid">
        <section class="card">
          <div class="site"><span class="logo">Y</span>YouTube favorite</div>
          <p>A target-blank sign-in link with <code>noopener</code>, matching the flow that previously became a Glance.</p>
          <div id="youtube-status" class="status">Not connected</div>
          <a id="youtube-google-sign-in" href="pistachio://accounts/oauth/google?flow=youtube" target="_blank" rel="noopener">Sign in with Google</a>
        </section>
        <section class="card">
          <div class="site"><span class="logo">X</span>X account</div>
          <p>A named JavaScript popup that must retain <code>window.opener</code> for its OAuth callback.</p>
          <div id="x-status" class="status">Not connected</div>
          <button id="x-google-sign-in" type="button">Continue with Google</button>
        </section>
      </div>
    </main>
    <script>
      const connected = (flow) =>
        localStorage.getItem('pistachio-auth-' + flow) === 'yes' ||
        document.cookie.split(';').some((part) => part.trim() === 'pistachio-auth-' + flow + '=yes');
      const sync = () => {
        for (const flow of ['youtube', 'x']) {
          const status = document.querySelector('#' + flow + '-status');
          const ready = connected(flow);
          status.textContent = ready ? 'Connected with Google' : 'Not connected';
          status.dataset.connected = String(ready);
          document.body.dataset[flow + 'Authenticated'] = String(ready);
        }
      };
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'pistachio-oauth-complete') sync();
      });
      window.addEventListener('storage', sync);
      document.querySelector('#x-google-sign-in').addEventListener('click', () => {
        window.open('pistachio://accounts/oauth/google?flow=x', 'x-google-oauth', 'popup=yes,width=520,height=680');
      });
      sync();
    </script>
  </body>
</html>`;
}

/** Offline Google-style consent page used by the OAuth popup E2E. */
export function demoOAuthHtml(flow: string): string {
  const safeFlow = flow === "x" ? "x" : "youtube";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
    <title>Sign in with Google</title>
    <style>
      :root { color-scheme:light; --ink:#202124; --muted:#5f6368; --blue:#1a73e8; --line:#dadce0; }
      * { box-sizing:border-box; } body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f7f9fc; color:var(--ink); font:14px/1.45 Arial,sans-serif; }
      main { width:min(420px,calc(100vw - 36px)); padding:34px; border:1px solid var(--line); border-radius:20px; background:white; box-shadow:0 18px 50px rgba(60,64,67,.13); }
      .g { display:grid; width:38px; height:38px; place-items:center; border-radius:50%; color:white; background:conic-gradient(#4285f4 0 25%,#34a853 0 50%,#fbbc05 0 75%,#ea4335 0); font-weight:800; }
      h1 { margin:20px 0 8px; font-size:24px; font-weight:500; } p { margin:0 0 22px; color:var(--muted); }
      .account { display:flex; align-items:center; gap:12px; padding:13px; border:1px solid var(--line); border-radius:12px; }
      .avatar { display:grid; width:32px; height:32px; place-items:center; border-radius:50%; color:white; background:#7b61a8; font-weight:700; }
      .account b,.account small { display:block; } .account small { color:var(--muted); }
      .opener { margin:18px 0; padding:9px 11px; border-radius:8px; color:#3c6250; background:#eef7ef; font-size:11px; }
      button { width:100%; border:0; border-radius:9px; padding:12px 15px; color:white; background:var(--blue); font-weight:700; cursor:pointer; }
      button:hover { background:#155fc0; }
    </style>
  </head>
  <body data-opener="pending">
    <main>
      <div class="g">G</div>
      <h1>Choose an account</h1>
      <p>Continue to ${safeFlow === "x" ? "X" : "YouTube"} in this Pistachio Space.</p>
      <div class="account"><span class="avatar">A</span><span><b>Avery Chen</b><small>avery@example.test</small></span></div>
      <div id="opener-status" class="opener"></div>
      <button id="continue" type="button">Continue as Avery</button>
    </main>
    <script>
      const flow = '${safeFlow}';
      const openerStatus = document.querySelector('#opener-status');
      const hasOpener = window.opener !== null;
      document.body.dataset.opener = hasOpener ? 'connected' : 'isolated';
      openerStatus.textContent = hasOpener ? 'Secure callback connected to the original tab' : 'No opener — the original tab will refresh from the shared session';
      document.querySelector('#continue').addEventListener('click', () => {
        location.href = 'pistachio://demo/oauth/callback?flow=' + encodeURIComponent(flow);
      });
    </script>
  </body>
</html>`;
}

/** Relying-party callback: commit session state, notify the opener, and close. */
export function demoOAuthCallbackHtml(flow: string): string {
  const safeFlow = flow === "x" ? "x" : "youtube";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' pistachio:; script-src 'unsafe-inline'" />
    <title>Authentication complete</title>
  </head>
  <body>
    <p>Authentication complete. Returning to ${safeFlow === "x" ? "X" : "YouTube"}…</p>
    <script>
      const flow = '${safeFlow}';
      localStorage.setItem('pistachio-auth-' + flow, 'yes');
      document.cookie = 'pistachio-auth-' + flow + '=yes; Max-Age=3600; Path=/; SameSite=Lax';
      if (window.opener !== null) window.opener.postMessage({ type: 'pistachio-oauth-complete', flow }, '*');
      window.close();
    </script>
  </body>
</html>`;
}
