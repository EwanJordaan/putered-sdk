import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EnvironmentTerminals} from '../dist/client/terminals.js';
import {Transport} from '../dist/client/transport.js';

test('SDK terminal defaults serialize cleanly, inputs stay ordered and output is decoded as bytes',async()=>{
  let id,sequence=0;const writes=[];
  const transport=new Transport('https://api.example','fixture-key',async(url,init)=>{
    const body=init.body?JSON.parse(init.body):undefined;
    if(url.endsWith('/environments/env_fixture/terminals')){assert.deepEqual(Object.keys(body),['id']);id=body.id;}
    if(url.endsWith('/input')){assert.equal(body.sequence,sequence++);writes.push(body);return Response.json({nextSequence:sequence});}
    return Response.json({id,environmentId:'env_fixture',state:init.method==='DELETE'?'closed':'running',nextSequence:sequence,createdAt:1,expiresAt:300001,output:Buffer.from('héllo').toString('base64'),cursor:6});
  });
  const session=await new EnvironmentTerminals(transport,'env_fixture').start();
  await Promise.all([session.write('one'),session.write('two'),session.resize(80,24)]);
  assert.deepEqual(writes.map(row=>row.sequence),[0,1,2]);
  assert.equal((await session.read()).outputBytes.toString(),'héllo');
  assert.equal((await session.stop()).state,'closed');
});
test('SDK terminal rejects substituted session identities before exposing output',async()=>{
  const id=crypto.randomUUID(),transport=new Transport('https://api.example','fixture-key',async()=>Response.json({id:crypto.randomUUID(),environmentId:'env_other',state:'running',nextSequence:0,createdAt:1,expiresAt:300001}));
  await assert.rejects(new EnvironmentTerminals(transport,'env_fixture').start({id}),error=>error.code==='PROTOCOL_ERROR');
});
