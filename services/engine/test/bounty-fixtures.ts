import { type Evidence, type Score } from '../src/bounty/schemas.js';
import { type Reviewer } from '../src/bounty/reviewer.js';
import { FakeCatalogue, FakePurchasing, fixtureProduct } from './fakes.js';
import { AppError } from '../src/errors.js';
import type { Invoice, Order } from '../src/bitrefill.js';
export const HEAD='a'.repeat(40);
export const BASE='b'.repeat(40);
export const bountyInput={ownerTelegramUserId:'123',repositoryId:303,requiredLabel:'reward-ready',mode:'ai_contribution_bounty',requireMerged:true,requireSuccessfulCI:true,scoreThreshold:50,
  tiers:[{minScore:50,maxScore:69,faceValueINR:50,productId:fixtureProduct.id,packageId:'fixture-package-50'},{minScore:70,maxScore:84,faceValueINR:100,productId:fixtureProduct.id,packageId:'fixture-package-100'},{minScore:85,maxScore:100,faceValueINR:200,productId:fixtureProduct.id,packageId:'fixture-package-200',requiresApproval:true}],autoApproveUpToUsdCents:150,perPurchaseCapUsdCents:300,dailyCapUsdCents:500,monthlyCapUsdCents:1000};
export function evidence(overrides:Partial<Evidence>={}):Evidence {
  return {installationId:404,repositoryId:303,repositoryFullName:'owner/repo',repositoryPrivate:false,prNumber:42,headSha:HEAD,baseSha:BASE,authorGithubUserId:202,authorLogin:'contributor',authorIsBot:false,merged:true,collectedAt:new Date().toISOString(),title:'Fix reward authorization and add regression tests',description:'Fix the linked correctness issue without changing spending caps.',labels:['reward-ready'],
    files:[{path:'src/reward.ts',status:'modified',additions:2,deletions:1,patch:'@@ -1 +1,2 @@\n-return true;\n+if (!authorized) return false;\n+return withinBudget;',patchTruncated:false},{path:'test/reward.test.ts',status:'added',additions:1,deletions:0,patch:'@@ -0,0 +1 @@\n+it("blocks unapproved rewards", () => expect(authorize(false)).toBe(false));',patchTruncated:false}],
    commits:[{sha:HEAD,message:'Fix authorization'}],checks:[{id:1,name:'required-tests',headSha:HEAD,status:'completed',conclusion:'success',required:true}],reviews:[{id:1,reviewerGithubUserId:101,headSha:HEAD,state:'APPROVED',body:'Checked the authorization change and tests.',feedbackResolved:true}],linkedIssues:[{number:7,title:'Block unauthorized payouts',body:'Unapproved rewards must not be paid.',state:'closed'}],evidenceTruncated:false,ciComplete:true,
    maintainerAuthorization:{actorGithubUserId:101,headSha:HEAD,label:'reward-ready',verifiedWriteAccess:true,source:'github_api_label_event',authorizedAt:new Date(Date.now()-2000).toISOString()},...overrides};
}
export function modelScore(score=60):Score {
  const subscores=score===90?{correctness:28,tests:23,feedback:18,maintainability:13,security:8}:score===75?{correctness:25,tests:20,feedback:15,maintainability:10,security:5}:score===30?{correctness:10,tests:5,feedback:5,maintainability:5,security:5}:{correctness:20,tests:15,feedback:10,maintainability:10,security:5};
  return {subscores,totalScore:score,confidence:0.95,findings:[{severity:'info',message:'Current tests and review support the authorization change.',evidenceRefs:['file:src/reward.ts','check:1','review:1','issue:7']}],reasoningSummary:'Specific authorization change, regression tests and current CI reviewed.',recommendedTier:score<50?null:score<70?1:score<85?2:3,riskFlags:[],manualReviewRequired:false,substantial:true};
}
export class FakeReviewer implements Reviewer {
  readonly model='TEST-MOCK-reviewer';
  output:unknown=modelScore();calls:Evidence[]=[];fail=false;wait?:Promise<void>;
  async review(e:Evidence){this.calls.push(e);if(this.wait)await this.wait;if(this.fail)throw new Error('TEST model unavailable');return this.output;}
}
export class BountyCatalogue extends FakeCatalogue {
  inStock=true;values=[50,100,200];
  override async product(id:string){if(id!==fixtureProduct.id)throw new AppError('INVALID_PACKAGE','Unknown test catalogue product');return {...fixtureProduct,id,inStock:this.inStock,packages:this.values.map(value=>({packageId:`fixture-package-${value}`,value}))};}
}
export class BountyPayments extends FakePurchasing {
  invoicePackages=new Map<string,{productId:string;packageId:string}>();accountBalance='100.00';balanceCurrency='USD';
  override async createInvoice(productId:string,packageId:string,purchaseId:string):Promise<Invoice>{const invoice=await super.createInvoice(productId,packageId,purchaseId);this.invoicePackages.set(invoice.id,{productId,packageId});return invoice;}
  async balance(){return {balance:this.accountBalance,currency:this.balanceCurrency};}
  override async order(id:string):Promise<Order>{const order=await super.order(id);const selected=this.invoicePackages.get(order.invoiceId!)!;return {...order,productId:selected.productId,productValue:selected.packageId.split('-').at(-1)!};}
}
