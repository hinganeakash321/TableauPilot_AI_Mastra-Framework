/**
 * File-intake HTTP routes for the Mastra dev server.
 *
 * A `.twbx` is a binary ZIP and must never be pasted into the Studio chat. These
 * routes let a user UPLOAD the file (browser drag-and-drop or curl); it is saved
 * into the uploads inbox and the agent then references it by filename via the
 * `listWorkbooks` tool. The binary is never sent to the LLM (spec section 57).
 */

import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { registerApiRoute } from "@mastra/core/server";
import { ensureUploadsDir, listWorkbookFiles } from "../../tableau/paths.js";

/** Keeps only a safe base filename and guarantees a .twbx/.twb extension check. */
function safeName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return base || "workbook.twbx";
}

const UPLOAD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TableauPilot AI - Start</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #e8eaf0; padding: 24px; }
  .card { width: min(600px, 94vw); background: #151922; border: 1px solid #232a36;
    border-radius: 16px; padding: 28px; box-shadow: 0 10px 40px rgba(0,0,0,.35); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .brand .dot { width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(135deg,#6ea8fe,#3b82f6);
    display: grid; place-items: center; font-size: 18px; }
  .brand h1 { font-size: 16px; margin: 0; letter-spacing: .2px; }
  .greeting { background: #10141c; border: 1px solid #232a36; border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; }
  .greeting p { margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: #dbe1ee; }
  .greeting p:last-child { margin-bottom: 0; color: #9aa3b2; font-size: 13px; }
  #drop { border: 2px dashed #33405a; border-radius: 12px; padding: 42px 20px; text-align: center;
    transition: .15s; cursor: pointer; background: #10141c; }
  #drop.hot { border-color: #6ea8fe; background: #131a27; }
  #drop .big { font-size: 15px; color: #cdd6e6; }
  #drop strong { color: #fff; }
  .hint { color: #7c8598; font-size: 12px; margin-top: 10px; }
  .status { margin-top: 18px; font-size: 13px; min-height: 20px; }
  .ok { color: #55d187; } .err { color: #ff8080; }
  .next { margin-top: 16px; display: none; background: #0f1a12; border: 1px solid #1f4030;
    border-radius: 10px; padding: 14px 16px; font-size: 13px; color: #cfe9d8; }
  .next b { color: #eafff2; }
  .files { margin-top: 22px; border-top: 1px solid #232a36; padding-top: 16px; }
  .files h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: #7c8598; margin: 0 0 10px; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; font-size: 13px; color: #c3cbd9; border-bottom: 1px solid #1b212c; }
  li:last-child { border-bottom: none; }
  li .sz { color: #7c8598; font-size: 12px; }
  code { background: #1d2432; padding: 1px 6px; border-radius: 6px; color: #cdd6e6; }
  .studio { margin-top: 20px; text-align: center; font-size: 12px; color: #7c8598; }
  .studio a { color: #6ea8fe; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="dot">📊</div>
      <h1>TableauPilot AI</h1>
    </div>

    <div class="greeting">
      <p>👋 <b>Welcome!</b> To start development, provide the Tableau workbook you want to build on.</p>
      <p>Upload the <code>.twbx</code> that contains the datasource — I'll inspect it, lock the datasource, and start creating worksheets from your requirements.</p>
    </div>

    <div id="drop">
      <div class="big">Drag &amp; drop your <strong>.twbx</strong> here, or click to choose</div>
      <div class="hint">Saved to the uploads inbox on your machine — never pasted into the chat or sent to the LLM.</div>
      <input id="file" type="file" accept=".twbx,.twb" hidden />
    </div>

    <div id="status" class="status"></div>
    <div id="next" class="next"></div>

    <div class="files">
      <h2>Available workbooks</h2>
      <ul id="list"></ul>
    </div>

    <div class="studio">Then open <a href="/" target="_blank">Mastra Studio</a> and chat with the agent.</div>
  </div>
<script>
  const drop = document.getElementById('drop');
  const input = document.getElementById('file');
  const status = document.getElementById('status');
  const next = document.getElementById('next');
  const list = document.getElementById('list');
  drop.addEventListener('click', () => input.click());
  ['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', ev => { if (ev.dataTransfer.files[0]) upload(ev.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); });
  async function upload(file) {
    if (!/\\.twbx?$/i.test(file.name)) { status.className = 'status err'; status.textContent = 'Please choose a .twbx or .twb file.'; return; }
    status.className = 'status'; status.textContent = 'Uploading ' + file.name + '...'; next.style.display = 'none';
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await fetch('/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Upload failed');
      status.className = 'status ok';
      status.innerHTML = 'Uploaded <code>' + json.name + '</code> (' + Math.round(json.sizeBytes/1024) + ' KB).';
      next.style.display = 'block';
      next.innerHTML = '<b>Next step:</b> open Mastra Studio, select the agent, and say: <code>Inspect ' + json.name + '</code>';
      refresh();
    } catch (e) { status.className = 'status err'; status.textContent = e.message; }
  }
  async function refresh() {
    try {
      const res = await fetch('/workbooks'); const json = await res.json();
      const items = json.workbooks || [];
      list.innerHTML = items.length
        ? items.map(w => '<li><code>' + w.name + '</code><span class="sz">' + Math.round(w.sizeBytes/1024) + ' KB</span></li>').join('')
        : '<li style="color:#7c8598">No workbooks uploaded yet.</li>';
    } catch {}
  }
  refresh();
</script>
</body>
</html>`;

export const uploadRoutes = [
  registerApiRoute("/upload", {
    method: "GET",
    handler: (c) => c.html(UPLOAD_PAGE),
  }),
  registerApiRoute("/start", {
    method: "GET",
    handler: (c) => c.html(UPLOAD_PAGE),
  }),
  registerApiRoute("/upload", {
    method: "POST",
    handler: async (c) => {
      try {
        const form = await c.req.formData();
        const file = form.get("file");
        if (!file || typeof file === "string") {
          return c.json({ ok: false, error: "No file provided (field 'file')." }, 400);
        }
        const name = safeName(file.name || "workbook.twbx");
        if (!/\.twbx?$/i.test(name)) {
          return c.json({ ok: false, error: "Only .twbx/.twb files are accepted." }, 400);
        }
        const dir = await ensureUploadsDir();
        const dest = join(dir, name);
        const bytes = Buffer.from(await file.arrayBuffer());
        await writeFile(dest, bytes);
        return c.json({ ok: true, name, path: dest, sizeBytes: bytes.length });
      } catch (err) {
        return c.json(
          { ok: false, error: err instanceof Error ? err.message : "Upload failed" },
          500,
        );
      }
    },
  }),
  registerApiRoute("/workbooks", {
    method: "GET",
    handler: async (c) => c.json({ workbooks: await listWorkbookFiles() }),
  }),
];
