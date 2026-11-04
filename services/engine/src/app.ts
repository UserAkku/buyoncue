import Fastify from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { type Engine } from './engine.js';
import { AppError } from './errors.js';
import { chatId, ruleSchema, triggerSchema } from './schemas.js';
import { BountyService } from './bounty/service.js';
import { UnconfiguredReviewer } from './bounty/reviewer.js';
import { privateChatId } from './bounty/schemas.js';
const uuidParams = z.object({ id:z.string().uuid() });
export function buildApp(engine: Engine, internalToken: string, bounties = new BountyService(engine,new UnconfiguredReviewer())) {
  // Disable request logging: headers, webhook bodies and redemption must never be logged.
  const app = Fastify({ logger:false, bodyLimit:64*1024, requestTimeout:15000 });
  const tokenHash=createHash('sha256').update(`Bearer ${internalToken}`).digest();
  app.addHook('onRequest', async (request, reply) => {
    const path=request.url.split('?')[0]!;
    if (path.startsWith('/v1/') || path==='/v1') {
      const supplied=createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(tokenHash,supplied)) return reply.code(401).send({error:{code:'UNAUTHORIZED',message:'Valid internal bearer token required'}});
    }
  });
  app.setErrorHandler((error,_request,reply)=>{
    if (error instanceof AppError) return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    if (error instanceof z.ZodError) return reply.code(400).send({error:{code:'INVALID_INPUT',message:'Request fields are invalid'}});
    const status=typeof error==='object' && error!==null && 'statusCode' in error ? Number(error.statusCode) : 0;
    if (status>=400 && status<500) return reply.code(status).send({error:{code:'INVALID_REQUEST',message:'Invalid request'}});
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'Request could not be completed'}});
  });
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'Route not found'}}));
  app.get('/health',async()=>({ok:true,service:'engine',livePurchasesEnabled:engine.liveEnabled}));
  app.get('/v1/products/search',async request=>{
    const q=z.object({query:z.string().min(1).max(100),country:z.string().regex(/^[A-Z]{2}$/).optional()}).strict().parse(request.query);
    return {products:await engine.catalogue.search(q.query,q.country)};
  });
  app.get('/v1/products/:id',async request=>{
    const {id}=z.object({id:z.string().min(1).max(500)}).parse(request.params);
    return {product:await engine.catalogue.product(id)};
  });
  app.post('/v1/rules',async(request,reply)=>reply.code(201).send({rule:await engine.createRule(ruleSchema.parse(request.body))}));
  app.get('/v1/rules',async request=>{
    const {ownerChatId}=z.object({ownerChatId:chatId}).strict().parse(request.query);
    return {rules:await engine.listRules(ownerChatId)};
  });
  for (const action of ['enable','pause','resume'] as const) {
    app.post(`/v1/rules/:id/${action}`,async request=>{
      const {id}=uuidParams.parse(request.params);
      const {ownerChatId}=z.object({ownerChatId:chatId}).strict().parse(request.body);
      return {rule:await engine.changeRule(id,ownerChatId,action)};
    });
  }
  app.post('/v1/triggers/github',async(request,reply)=>reply.code(202).send(await engine.trigger(triggerSchema.parse(request.body))));
  app.post('/v1/approvals/:id',async request=>{
    const {id}=uuidParams.parse(request.params);
    const {ownerChatId,decision}=z.object({ownerChatId:chatId,decision:z.enum(['approve','reject'])}).strict().parse(request.body);
    return engine.approval(id,ownerChatId,decision);
  });
  app.get('/v1/purchases',async request=>{
    const {ownerChatId}=z.object({ownerChatId:chatId}).strict().parse(request.query);
    return {purchases:await engine.listPurchases(ownerChatId)};
  });
  app.get('/v1/notifications',async request=>{
    const {limit}=z.object({limit:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(request.query);
    return {items:await engine.notifications(limit)};
  });
  app.post('/v1/notifications/:id/ack',async request=>engine.ack(uuidParams.parse(request.params).id));
  app.post('/v1/github/links',async(request,reply)=>reply.code(201).send({link:await bounties.link(request.body)}));
  app.post('/v1/github/links/unlink',async request=>bounties.unlink(request.body));
  app.post('/v1/repositories/connect',async(request,reply)=>reply.code(201).send({repository:await bounties.connect(request.body)}));
  app.get('/v1/repositories',async request=>{
    const {ownerTelegramUserId}=z.object({ownerTelegramUserId:privateChatId}).strict().parse(request.query);
    return {repositories:await bounties.repositories(ownerTelegramUserId)};
  });
  app.post('/v1/bounty-rules',async(request,reply)=>reply.code(201).send({rule:await bounties.createRule(request.body)}));
  app.get('/v1/bounty-rules',async request=>{
    const {ownerTelegramUserId}=z.object({ownerTelegramUserId:privateChatId}).strict().parse(request.query);
    return {rules:await bounties.rules(ownerTelegramUserId)};
  });
  app.post('/v1/contributions/review',{bodyLimit:1024*1024},async(request,reply)=>reply.code(202).send(await bounties.submit(request.body)));
  app.get('/v1/contributions/:id',async request=>bounties.get(uuidParams.parse(request.params).id));
  app.post('/v1/contributions/:id/finalize',async(request,reply)=>{
    const result=await bounties.finalize(uuidParams.parse(request.params).id,request.body);
    return reply.code(result.accepted?202:200).send(result);
  });
  app.get('/v1/bounty-receipts/:id',async request=>({receipt:await bounties.receipt(uuidParams.parse(request.params).id)}));
  app.post('/webhooks/bitrefill',async request=>{
    // Bitrefill documents a full invoice object. Only its bounded ID is retained.
    const {id}=z.object({id:z.string().min(1).max(500)}).parse(request.body);
    return engine.webhook(id);
  });
  return app;
}
