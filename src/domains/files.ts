import { access, constants, stat, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { safeJs } from "../util/js-template";
import { pdfPath } from "../util/paths";

const UploadArgs = Type.Object({
  selector: Type.String({ description: "CSS selector of the file <input>" }),
  filePath: Type.String({ description: "Absolute path to the file to upload" }),
});

const verifyReadable = async (filePath: string): Promise<Result<void, ToolErr>> => {
  try {
    await access(filePath, constants.R_OK);
    return ok(undefined);
  } catch (e) {
    return err({
      kind: "io_error",
      message: `Cannot read file: ${filePath} (${e instanceof Error ? e.message : String(e)})`,
    });
  }
};

const tryCdpUpload = async (
  client: BrowserClient,
  selector: string,
  filePath: string,
): Promise<Result<void, ToolErr>> => {
  const doc = await client.session().call("DOM.getDocument", { depth: -1 });
  if (!doc.success) return err({ kind: "cdp_error", message: doc.error.message });
  // CDP boundary cast: DOM.getDocument returns { root: { nodeId: number } }
  const root = (doc.data as { root: { nodeId: number } }).root;
  const q = await client.session().call("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!q.success) return err({ kind: "cdp_error", message: q.error.message });
  // CDP boundary cast: DOM.querySelector returns { nodeId: number }
  const nodeId = (q.data as { nodeId: number }).nodeId;
  if (!nodeId) return err({ kind: "invalid_state", message: `Selector matched 0 file inputs: ${selector}` });
  const set = await client.session().call("DOM.setFileInputFiles", { files: [filePath], nodeId });
  if (!set.success) return err({ kind: "cdp_error", message: set.error.message });
  const verify = await client.evaluateJs(safeJs`document.querySelector(${selector})?.files?.length || 0`);
  if (!verify.success) return err({ kind: "cdp_error", message: verify.error.message });
  if (Number(verify.data ?? 0) === 0) {
    return err({ kind: "invalid_state", message: "CDP upload reported success but file count is 0" });
  }
  return ok(undefined);
};

const inferMime = (name: string): string => {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".json")) return "application/json";
  return "text/plain";
};

const jsFallbackUpload = async (
  client: BrowserClient,
  selector: string,
  filePath: string,
): Promise<Result<void, ToolErr>> => {
  const buf = await readFile(filePath);
  const st = await stat(filePath);
  const name = basename(filePath);
  const mime = inferMime(name);
  const expr = safeJs`
    (() => {
      const input = document.querySelector(${selector});
      if (!input || input.type !== 'file') throw new Error('File input not found');
      const bin = atob(${buf.toString("base64")});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${name}, { type: ${mime}, lastModified: ${st.mtimeMs} });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.files.length;
    })()
  `;
  const r = await client.evaluateJs(expr);
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
  if (!Number(r.data ?? 0)) return err({ kind: "invalid_state", message: "JS fallback set 0 files" });
  return ok(undefined);
};

export const uploadFileTool = defineBrowserTool({
  name: "browser_upload_file",
  label: "Browser Upload File",
  description: "Set files on a file <input> via CDP, with a JS-DataTransfer fallback for stubborn pages.",
  promptSnippet: "Upload a file to a file input",
  promptGuidelines: [
    "File path must be absolute and readable.",
    "Selector must match a file input.",
  ],
  parameters: UploadArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const readable = await verifyReadable(args.filePath);
    if (!readable.success) return readable;
    const cdp = await tryCdpUpload(client, args.selector, args.filePath);
    if (cdp.success) {
      return ok({
        text: `Uploaded ${args.filePath} via CDP`,
        details: { mode: "cdp", filePath: args.filePath },
      });
    }
    const js = await jsFallbackUpload(client, args.selector, args.filePath);
    if (js.success) {
      return ok({
        text: `Uploaded ${args.filePath} via JS DataTransfer`,
        details: { mode: "js", filePath: args.filePath },
      });
    }
    return err({
      kind: "cdp_error",
      message: `Both CDP and JS fallback failed. CDP: ${cdp.error.message}; JS: ${js.error.message}`,
    });
  },
});

const DownloadArgs = Type.Object({
  downloadPath: Type.String({ description: "Absolute path to a writable directory where downloads should be saved" }),
});

export const downloadTool = defineBrowserTool({
  name: "browser_download",
  label: "Browser Download",
  description: "Configure Chrome's download behavior: set the save directory and disable the save-as prompt.",
  promptSnippet: "Configure download directory",
  promptGuidelines: [
    "Pass an absolute path to an existing writable directory.",
    "Affects all subsequent downloads on this browser.",
  ],
  parameters: DownloadArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    try {
      const s = await stat(args.downloadPath);
      if (!s.isDirectory()) {
        return err({ kind: "io_error", message: `Not a directory: ${args.downloadPath}` });
      }
      await access(args.downloadPath, constants.W_OK);
    } catch (e) {
      return err({
        kind: "io_error",
        message: `Download path unusable: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const r = await client.session().callBrowser("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: args.downloadPath,
      eventsEnabled: true,
    });
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({
      text: `Downloads will save to: ${args.downloadPath}`,
      details: { downloadPath: args.downloadPath },
    });
  },
});

const PrintPdfArgs = Type.Object({
  outputPath: Type.Optional(Type.String({ description: "Where to save the PDF. Default: tmpdir + uuid." })),
});

export const printToPdfTool = defineBrowserTool({
  name: "browser_print_to_pdf",
  label: "Browser Print to PDF",
  description: "Print the current page to a PDF file using Chrome's Page.printToPDF.",
  promptSnippet: "Print the current page to PDF",
  promptGuidelines: ["Default output path is in tmpdir; pass outputPath to control."],
  parameters: PrintPdfArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.session().call("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
    });
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    // CDP boundary cast: Page.printToPDF returns { data: string } (base64-encoded PDF)
    const data = (r.data as { data: string }).data;
    const path = args.outputPath ?? pdfPath(client.namespace);
    await writeFile(path, Buffer.from(data, "base64"));
    return ok({ text: `PDF saved: ${path}`, details: { path } });
  },
});
