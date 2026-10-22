import { z } from 'zod';
import { PuteredError } from '../errors.js';
import { randomUUID } from 'node:crypto';
import type { Transport } from './transport.js';
const stateSchema=z.object({id:z.string().uuid(),environmentId:z.string(),state:z.enum(['starting','running','stopping','saving','closed','failed','unknown']),
  nextSequence:z.number().int().nonnegative(),createdAt:z.number().int(),expiresAt:z.number().int(),exitCode:z.number().int().optional(),error:z.string().optional(),
  output:z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).max(90000).optional(),cursor:z.number().int().nonnegative().optional(),reset:z.boolean().optional(),
  allocationUsage:z.object({enforced:z.literal(true),durationMs:z.number().int().nonnegative(),cpuQuotaMicros:z.number().int().positive(),memoryBytes:z.number().int().positive()}).optional()});
export type TerminalState=z.infer<typeof stateSchema>;
export class TerminalSession{
  private sequence=0;
  constructor(private readonly transport:Transport,readonly id:string,readonly environmentId:string,initialSequence=0){this.sequence=initialSequence;}
  private checked(value:TerminalState){if(value.id!==this.id||value.environmentId!==this.environmentId)throw new PuteredError('Terminal identity mismatch.','PROTOCOL_ERROR');this.sequence=Math.max(this.sequence,value.nextSequence);return value;}
  async read(options:{cursor?:number;signal?:AbortSignal}={}){
    const cursor=z.number().int().nonnegative().parse(options.cursor??0),state=this.checked(await this.transport.request('/terminals/'+this.id+'?cursor='+cursor,'GET',stateSchema,undefined,options.signal));
    if(state.cursor!==undefined&&state.cursor<cursor)throw new PuteredError('Terminal cursor moved backwards.','PROTOCOL_ERROR');
    return {...state,outputBytes:Buffer.from(state.output??'','base64')};
  }
  private pending:Promise<unknown>=Promise.resolve();
  private input(value:object,signal?:AbortSignal){
    const operation=this.pending.then(async()=>{const sequence=this.sequence;const result=await this.transport.request('/terminals/'+this.id+'/input','POST',z.object({nextSequence:z.number().int().min(sequence+1)}),{sequence,...value},signal);this.sequence=result.nextSequence;return result;});
    this.pending=operation.catch(()=>{});return operation;
  }
  write(input:string|Uint8Array,options:{signal?:AbortSignal}={}){
    const bytes=typeof input==='string'?Buffer.from(input):Buffer.from(input);
    if(bytes.length>24576)throw new PuteredError('Terminal input exceeds 24 KiB.','PAYLOAD_TOO_LARGE');
    return this.input({input:bytes.toString('base64')},options.signal);
  }
  resize(columns:number,rows:number,options:{signal?:AbortSignal}={}){
    const value=z.object({columns:z.number().int().min(20).max(300),rows:z.number().int().min(5).max(120)}).parse({columns,rows});return this.input(value,options.signal);
  }
  async stop(options:{signal?:AbortSignal}={}){return this.checked(await this.transport.request('/terminals/'+this.id,'DELETE',stateSchema,undefined,options.signal));}
}
export class EnvironmentTerminals{
  constructor(private readonly transport:Transport,private readonly environmentId:string){}
  async start(options:{id?:string;columns?:number;rows?:number;signal?:AbortSignal}={}){
    const value=z.object({id:z.string().uuid(),columns:z.number().int().min(20).max(300).optional(),rows:z.number().int().min(5).max(120).optional()}).parse({id:options.id??randomUUID(),...(options.columns===undefined?{}:{columns:options.columns}),...(options.rows===undefined?{}:{rows:options.rows})});
    const result=await this.transport.request('/environments/'+this.environmentId+'/terminals','POST',stateSchema,value,options.signal);
    if(result.id!==value.id||result.environmentId!==this.environmentId)throw new PuteredError('Terminal identity mismatch.','PROTOCOL_ERROR');
    return new TerminalSession(this.transport,result.id,this.environmentId,result.nextSequence);
  }
  async connect(id:string,options:{signal?:AbortSignal}={}){z.string().uuid().parse(id);const terminal=new TerminalSession(this.transport,id,this.environmentId);await terminal.read(options);return terminal;}
}
