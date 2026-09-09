import { createHash, randomBytes } from 'node:crypto';
import { Accounts } from './accounts.ts';

export type GithubGrant={kind:'github-app-user';accessToken:string;refreshToken:string;expiresAt:number;refreshExpiresAt:number;githubUserId:number;installationId:number;repositories:string[]};
const headers=(token:string)=>({Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28'});
async function github(path:string,token:string){const r=await fetch(`https://api.github.com${path}`,{headers:headers(token),signal:AbortSignal.timeout(20000)});const data=await r.json() as any;if(!r.ok)throw new Error(data.message||`GitHub HTTP ${r.status}`);return data;}
export function githubAppConfig(env=process.env){return{clientId:(env.GITHUB_APP_CLIENT_ID||'').trim(),clientSecret:(env.GITHUB_APP_CLIENT_SECRET||'').trim(),slug:(env.GITHUB_APP_SLUG||'').trim()};}
export function verifier(){return randomBytes(32).toString('base64url');}
export function challenge(value:string){return createHash('sha256').update(value).digest('base64url');}
export async function exchange(code:string,codeVerifier:string,redirectUri:string,config=githubAppConfig()){
  const body=new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,code,redirect_uri:redirectUri,code_verifier:codeVerifier});
  const r=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(20000)});
  const data=await r.json() as any;if(!r.ok||!data.access_token)throw new Error(data.error_description||'GitHub did not complete the connection.');return data;
}
export async function buildGrant(token:any,installationId:number):Promise<GithubGrant>{
  const user=await github('/user',token.access_token);const installs=await github('/user/installations?per_page=100',token.access_token);
  if(!installs.installations?.some((x:any)=>x.id===installationId))throw new Error('The selected GitHub installation is not available to this user.');
  const repos=await github(`/user/installations/${installationId}/repositories?per_page=100`,token.access_token);
  return{kind:'github-app-user',accessToken:token.access_token,refreshToken:token.refresh_token||'',expiresAt:Date.now()+(token.expires_in||28800)*1000,refreshExpiresAt:Date.now()+(token.refresh_token_expires_in||0)*1000,githubUserId:user.id,installationId,repositories:(repos.repositories||[]).map((x:any)=>x.full_name)};
}
export function grantMeta(raw:string){try{const g=JSON.parse(raw) as GithubGrant;return g.kind==='github-app-user'?{type:'github-app',repositories:g.repositories,installationId:g.installationId}:undefined;}catch{return undefined;}}
export async function githubToken(accounts:Accounts,userId:string,config=githubAppConfig()){
  const raw=accounts.credentials(userId).GITHUB_TOKEN||'';let grant:GithubGrant;
  try{grant=JSON.parse(raw);}catch{return raw;}
  if(grant.kind!=='github-app-user')return raw;
  if(grant.expiresAt>Date.now()+60000)return grant.accessToken;
  if(!grant.refreshToken||grant.refreshExpiresAt<=Date.now())throw new Error('GitHub authorization expired. Reconnect GitHub.');
  const body=new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,grant_type:'refresh_token',refresh_token:grant.refreshToken});
  const r=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(20000)});
  const token=await r.json() as any;if(!r.ok||!token.access_token)throw new Error('GitHub authorization was revoked or expired. Reconnect GitHub.');
  const refreshed=await buildGrant(token,grant.installationId);if(refreshed.githubUserId!==grant.githubUserId)throw new Error('GitHub connection identity changed. Reconnect GitHub.');
  accounts.setConnection(userId,'GITHUB_TOKEN',JSON.stringify(refreshed));return refreshed.accessToken;
}
