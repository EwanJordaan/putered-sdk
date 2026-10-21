import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Putered, CommandError, PuteredError } from '../dist/client/sdk.js';

const environment = { id:'env_output', tools:[], settings:{} };
const jobId = '6ab8dedc-1c8b-4eed-ae76-c0a9a462bb11';
const data = { stdout:'hello\n',stdoutBase64:'aGVsbG8K',stderr:'warning\n',exitCode:0,durationMs:1,hostDurationMs:2 };

test('output reads collected sync/async results and preserves the existing serializable contract',async()=>{
  for(const asynchronous of [false,true]){
    let calls=0;
    const sdk=new Putered({baseUrl:'https://putered.invalid',apiKey:'x'.repeat(32),config:{},fetch:async(url,options)=>{
      calls++;
      if(url.endsWith('/execution-jobs/'+jobId))return Response.json({id:jobId,environmentId:environment.id,state:'completed',httpStatus:200,result:data});
      return Response.json(options.method==='POST'?(asynchronous?{jobId,state:'running'}:data):environment);
    }});
    const env=await sdk.environments.connect(environment.id);
    const command=await env.exec('echo hello',{async:asynchronous});
    const before=calls;
    assert.equal(await command.output(),'hello\nwarning\n');
    assert.equal(await command.output('stdout'),'hello\n');
    assert.equal(await command.output('stderr'),'warning\n');
    assert.equal(calls,before);
    assert.deepEqual(command,data);
    assert.deepEqual(JSON.parse(JSON.stringify(command)),data);
    await assert.rejects(command.output('invalid'),error=>error.code==='INVALID_INPUT');
  }
});

test('nonzero commands throw only on output(), preserving both streams and complete result',async()=>{
  for(const asynchronous of [false,true]){
    const failed={...data,exitCode:2,stdout:'',stdoutBase64:'',stderr:'build failed\n'};
    const sdk=new Putered({baseUrl:'https://putered.invalid',apiKey:'x'.repeat(32),config:{},fetch:async(url,options)=>{
      if(url.endsWith('/execution-jobs/'+jobId))return Response.json({id:jobId,environmentId:environment.id,state:'completed',httpStatus:200,result:failed});
      return Response.json(options.method==='POST'?(asynchronous?{jobId,state:'running'}:failed):environment);
    }});
    const env=await sdk.environments.connect(environment.id);
    const command=await env.exec('exit 2',{async:asynchronous});
    for(const stream of ['both','stdout','stderr'])await assert.rejects(command.output(stream),error=>{
      assert.ok(error instanceof CommandError && error instanceof PuteredError);
      assert.equal(error.output,'build failed\n');assert.equal(error.exitCode,2);
      assert.equal(error.stdout,'');assert.equal(error.stderr,'build failed\n');
      assert.equal(error.result,command);assert.equal(error.code,'EXECUTION_FAILED');
      return true;
    });
  }
});
