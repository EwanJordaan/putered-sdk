import { z } from "zod";
import { constants } from "node:fs";
import { open, lstat, link, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { capturePresetSchema, captureScope, presetIdSchema, presetNameSchema,
  PRESET_MAX_BYTES, type Preset } from "../preset-contract.js";
import { environmentSchema } from "../tool-contract.js";
import { PuteredError } from "../errors.js";
import type { Transport } from "./transport.js";
import { presetResponseSchema } from "./responses.js";

const archiveType = "application/vnd.oci.image.layout.v1+tar";
export interface PresetRequestOptions { signal?: AbortSignal; onOperation?: (id: string) => void }
export interface PresetTransferOptions extends PresetRequestOptions {
  onProgress?: (progress: { completedBytes: number; totalBytes: number }) => void;
}
export interface PresetUploadOptions extends PresetTransferOptions { name: string; file: string }
export interface PresetDownloadOptions extends PresetTransferOptions { destination: string }
// Legacy state selection is deliberately distinct from workspace-only OCI capture.
export type CapturePresetOptions = PresetRequestOptions & { name: string } & (
  { mode?: never; workspace?: never; home?: never } |
  { mode: "state"; workspace?: string[]; home?: string[] }
);

function input<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { return schema.parse(value); }
  catch (error) { throw new PuteredError("Invalid preset options.", "INVALID_INPUT", { cause: error }); }
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new PuteredError("Preset request cancelled; publication may already have completed.", "CANCELLED");
}
function pathInput(path: string) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0"))
    throw new PuteredError("Supply a nonempty file path.", "INVALID_INPUT");
  return resolve(path);
}
const operationSchema=z.object({id:z.string().uuid(),state:z.enum(['prepared','uploading','running','ready','failed','unknown','cancelled']),result:presetResponseSchema.optional(),error:z.string().optional()});
async function waitOperation(transport:Transport,id:string,signal?:AbortSignal):Promise<Preset>{
  const deadline=Date.now()+20*60000;
  while(Date.now()<deadline){
    cancelled(signal);
    const operation=await transport.request('/preset-operations/'+id,'GET',operationSchema,undefined,signal);
    if(operation.id!==id)throw new PuteredError('Operation ID mismatch.','PROTOCOL_ERROR');
    if(operation.state==='ready'){if(!operation.result)throw new PuteredError('Missing ready image.','PROTOCOL_ERROR');return operation.result;}
    if(['failed','unknown','cancelled'].includes(operation.state))throw new PuteredError((operation.error||'Image operation '+operation.state)+'. Inspect operation '+id+' before retrying.',operation.state==='unknown'?'CONFLICT':'PACKAGE_INVALID');
    await new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,1000),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new PuteredError('Cancelled; inspect operation '+id+' before retrying.','CANCELLED'));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  }
  throw new PuteredError('Image operation is still pending. Inspect '+id+' before retrying.','TIMEOUT');
}

export async function capturePreset(transport: Transport, environmentId: string, options: CapturePresetOptions): Promise<Preset> {
  input(environmentSchema.shape.id, environmentId);
  const { signal, onOperation, ...value } = options;
  const request = input(capturePresetSchema, value), scope = captureScope(request);
  if (scope !== "state" && (request.workspace.length || request.home.length))
    throw new PuteredError("Save scopes do not accept workspace/home selections.", "INVALID_INPUT");
  cancelled(signal);
  let result:Preset;
  if(transport.accountApi){
    if(request.mode==='state')throw new PuteredError('Legacy state captures are not available through account keys.','POLICY_DENIED');
    const id=randomUUID();onOperation?.(id);
    const operation=await transport.request('/preset-operations','POST',operationSchema,{id,kind:'capture',name:request.name,environmentId},signal);
    if(operation.id!==id)throw new PuteredError('Operation ID mismatch.','PROTOCOL_ERROR');
    result=await waitOperation(transport,id,signal);
  }else result = await transport.request(`/environments/${environmentId}/preset`, "POST", presetResponseSchema, {
    name: request.name, workspace: request.workspace, home: request.home,
    ...(request.mode === undefined ? {} : { mode: request.mode }),
  }, signal);
  const explicitScope = request.mode === "state";
  if (result.source !== "capture" || result.environmentId !== environmentId || result.name !== request.name ||
    (explicitScope ? result.captureScope !== scope : !["complete", "workspace-only"].includes(result.captureScope ?? "")))
    throw new PuteredError("Captured preset does not match the request.", "PROTOCOL_ERROR");
  return result;
}

export class Presets {
  constructor(private readonly transport: Transport) {}
  async operation(id:string,options:PresetRequestOptions={}){
    input(z.string().uuid(),id);cancelled(options.signal);
    const record=await this.transport.request('/preset-operations/'+id,'GET',operationSchema,undefined,options.signal);
    if(record.id!==id)throw new PuteredError('Operation ID mismatch.','PROTOCOL_ERROR');return record;
  }
  async list(options: PresetRequestOptions = {}): Promise<Preset[]> {
    cancelled(options.signal);
    return this.transport.request("/presets", "GET", z.array(presetResponseSchema), undefined, options.signal);
  }
  async get(id: string, options: PresetRequestOptions = {}): Promise<Preset> {
    input(presetIdSchema, id); cancelled(options.signal);
    const result = await this.transport.request(`/presets/${id}`, "GET", presetResponseSchema, undefined, options.signal);
    if (result.id !== id) throw new PuteredError("Preset response ID mismatch.", "PROTOCOL_ERROR");
    return result;
  }
  async upload(options: PresetUploadOptions): Promise<Preset> {
    const name = input(presetNameSchema, options.name), path = pathInput(options.file);
    cancelled(options.signal);
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { throw new PuteredError("Could not open preset archive.", "INVALID_INPUT", { cause: error }); }
    let stream: Readable | undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new PuteredError("Preset archive must be a regular file.", "INVALID_INPUT");
      if (stat.size > PRESET_MAX_BYTES) throw new PuteredError("Preset archive exceeds 1 GiB.", "PAYLOAD_TOO_LARGE");
      if (stat.size < 1024) throw new PuteredError("Preset archive is too small to be an OCI layout tar.", "INVALID_INPUT");
      const digest = createHash("sha256"); let completedBytes = 0;
      const progress = () => options.onProgress?.({ completedBytes, totalBytes: stat.size });
      progress();
      if(this.transport.accountApi){
        const id=randomUUID();options.onOperation?.(id);
        const operation=await this.transport.request('/preset-operations','POST',operationSchema,{id,name,kind:'upload',bytes:stat.size},options.signal);
        if(operation.id!==id||operation.state!=='uploading')throw new PuteredError('Invalid upload operation.','PROTOCOL_ERROR');
        while(completedBytes<stat.size){
          cancelled(options.signal);
          const bytes=Buffer.allocUnsafe(Math.min(8*1024*1024,stat.size-completedBytes));let read=0;
          while(read<bytes.length){const next=await file.read(bytes,read,bytes.length-read,completedBytes+read);if(!next.bytesRead)throw new PuteredError('Archive changed during upload.','INVALID_INPUT');read+=next.bytesRead;}
          const index=Math.floor(completedBytes/(8*1024*1024)),hash=createHash('sha256').update(bytes).digest('hex');
          const part=await this.transport.request('/preset-operations/'+id+'/parts/'+index,'PUT',z.object({index:z.literal(index),bytes:z.literal(bytes.length),sha256:z.literal(hash)}),undefined,options.signal,bytes);
          digest.update(bytes);completedBytes+=part.bytes;progress();
        }
        const completed=await this.transport.request('/preset-operations/'+id+'/complete','POST',operationSchema,{},options.signal);
        if(completed.id!==id)throw new PuteredError('Operation ID mismatch.','PROTOCOL_ERROR');
        const result=await waitOperation(this.transport,id,options.signal);
        if(result.archiveSha256!==digest.digest('hex')||result.bytes!==stat.size||result.name!==name||result.source!=='upload')throw new PuteredError('Uploaded image mismatch.','PROTOCOL_ERROR');
        return result;
      }
      stream = Readable.from((async function* () {
        while (completedBytes < stat.size) {
          cancelled(options.signal);
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - completedBytes));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, completedBytes);
          if (!bytesRead) throw new PuteredError("Preset archive changed during upload.", "INVALID_INPUT");
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk); completedBytes += bytesRead;
          progress(); yield chunk;
        }
      })());
      const result = await this.transport.upload(`/presets?name=${encodeURIComponent(name)}`, presetResponseSchema, stream,
        archiveType, stat.size, options.signal);
      if (completedBytes !== stat.size || result.archiveSha256 !== digest.digest("hex") || result.bytes !== stat.size ||
        result.name !== name || result.source !== "upload")
        throw new PuteredError("Uploaded preset does not match the supplied archive.", "PROTOCOL_ERROR");
      return result;
    } catch (error) {
      cancelled(options.signal);
      if (error instanceof PuteredError) throw error;
      throw new PuteredError("Could not read preset archive.", "INVALID_INPUT", { cause: error });
    } finally { stream?.destroy(); await file.close(); }
  }
  /** Stream into a private staging file; publish only after checksum verification, never overwriting a destination. */
  async download(id: string, options: PresetDownloadOptions): Promise<Preset> {
    input(presetIdSchema, id);
    const destination = pathInput(options.destination);
    cancelled(options.signal);
    try {
      await lstat(destination);
      throw new PuteredError("Download destination already exists.", "CONFLICT");
    } catch (error) {
      if (error instanceof PuteredError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new PuteredError("Could not inspect download destination.", "STORAGE_ERROR", { cause: error });
    }
    const record = await this.get(id, options);
    let staging: string | undefined;
    let response: Response | undefined;
    try {
      staging = await mkdtemp(join(dirname(destination), ".putered-download-"));
      const path = join(staging, "archive.tar");
      response = await this.transport.download(`/presets/${id}/archive`, options.signal);
      if (response.headers.get("content-type")?.split(";")[0].trim() !== archiveType || !response.body)
        throw new PuteredError("Expected an OCI archive response.", "PROTOCOL_ERROR");
      const file = await open(path, "wx", 0o600);
      try {
        const digest = createHash("sha256"); let completedBytes = 0;
        options.onProgress?.({ completedBytes, totalBytes: record.bytes });
        const reader = response.body.getReader();
        const source = async function* () {
          try {
            for (;;) {
              cancelled(options.signal);
              let next;
              try { next = await reader.read(); }
              catch (error) { throw new PuteredError("Could not read preset download.", "NETWORK_ERROR", { cause: error }); }
              if (next.done) break;
              completedBytes += next.value.byteLength;
              if (completedBytes > record.bytes) throw new PuteredError("Preset download exceeds its declared size.", "PROTOCOL_ERROR");
              digest.update(next.value);
              yield next.value;
              options.onProgress?.({ completedBytes, totalBytes: record.bytes });
            }
            if (completedBytes !== record.bytes || digest.digest("hex") !== record.archiveSha256)
              throw new PuteredError("Preset download checksum or size mismatch.", "PROTOCOL_ERROR");
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        };
        for await (const chunk of source()) await file.writeFile(chunk);
        await file.sync();
      } finally { await file.close(); }
      cancelled(options.signal);
      await link(path, destination);
      return record;
    } catch (error) {
      cancelled(options.signal);
      if (error instanceof PuteredError) throw error;
      throw new PuteredError("Could not save preset archive.", (error as NodeJS.ErrnoException).code === "EEXIST" ? "CONFLICT" : "STORAGE_ERROR", { cause: error });
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
