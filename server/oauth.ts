import * as oidc from 'openid-client';
import type { Accounts, IdentityProvider } from './accounts.ts';

type ProviderConfig = {clientId:string;clientSecret:string};
type OauthConfig = Record<IdentityProvider, ProviderConfig>;
const issuers = {google:'https://accounts.google.com', slack:'https://slack.com'} as const;

export function oauthConfig(env = process.env): OauthConfig {
  return {
    google:{clientId:env.GOOGLE_CLIENT_ID || '',clientSecret:env.GOOGLE_CLIENT_SECRET || ''},
    github:{clientId:env.GITHUB_CLIENT_ID || '',clientSecret:env.GITHUB_CLIENT_SECRET || ''},
    slack:{clientId:env.SLACK_CLIENT_ID || '',clientSecret:env.SLACK_CLIENT_SECRET || ''}
  };
}

export class SocialAuth {
  private discovered = new Map<'google'|'slack',Promise<oidc.Configuration>>();
  constructor(private accounts:Accounts, private origin:string, private config=oauthConfig()) {}
  available() { return Object.fromEntries(Object.entries(this.config).map(([provider,value]) => [provider,Boolean(value.clientId && value.clientSecret)])); }
  private callback(provider:IdentityProvider) { return `${this.origin}/api/auth/${provider}/callback`; }
  private oidcConfig(provider:'google'|'slack') {
    let value = this.discovered.get(provider);
    if (!value) {
      const config = this.config[provider];
      value = oidc.discovery(new URL(issuers[provider]), config.clientId, config.clientSecret);
      this.discovered.set(provider,value);
    }
    return value;
  }
  async start(provider:IdentityProvider) {
    const config = this.config[provider];
    if (!config.clientId || !config.clientSecret) throw new Error(`${provider[0].toUpperCase()+provider.slice(1)} sign-in is not configured yet.`);
    const verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
    const state = await this.accounts.beginOauth(provider,verifier,nonce);
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const common = {client_id:config.clientId,redirect_uri:this.callback(provider),response_type:'code',state,code_challenge:challenge,code_challenge_method:'S256'};
    if (provider === 'github') return {state,url:new URL(`https://github.com/login/oauth/authorize?${new URLSearchParams({...common,scope:'read:user user:email'})}`)};
    const client = await this.oidcConfig(provider);
    return {state,url:oidc.buildAuthorizationUrl(client,{...common,scope:'openid profile email',nonce})};
  }
  async finish(provider:IdentityProvider, callbackUrl:URL, cookieState:string) {
    const state = callbackUrl.searchParams.get('state') || '';
    if (!state || state !== cookieState) throw new Error('The sign-in request did not match this browser. Please try again.');
    const saved = await this.accounts.consumeOauth(provider,state);
    if (!saved) throw new Error('The sign-in request expired or was already used. Please try again.');
    if (provider === 'github') {
      const input = new URLSearchParams({client_id:this.config.github.clientId,client_secret:this.config.github.clientSecret,code:callbackUrl.searchParams.get('code') || '',redirect_uri:this.callback(provider),code_verifier:saved.verifier});
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:input});
      const token = await tokenResponse.json() as {access_token?:string;error_description?:string};
      if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || 'GitHub did not complete sign-in.');
      const userResponse = await fetch('https://api.github.com/user',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token.access_token}`,'X-GitHub-Api-Version':'2022-11-28'}});
      const user = await userResponse.json() as {id?:number;login?:string;email?:string;message?:string};
      if (!userResponse.ok || !user.id || !user.login) throw new Error(user.message || 'GitHub identity could not be verified.');
      return this.accounts.socialLogin(provider,String(user.id),user.login,user.email || '');
    }
    const client = await this.oidcConfig(provider);
    const tokens = await oidc.authorizationCodeGrant(client,callbackUrl,{pkceCodeVerifier:saved.verifier,expectedState:state,expectedNonce:saved.nonce,idTokenExpected:true});
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error('The identity provider did not return a verified user ID.');
    const email = typeof claims.email === 'string' ? claims.email : '';
    const preferred = typeof claims.preferred_username === 'string' ? claims.preferred_username : typeof claims.name === 'string' ? claims.name : email.split('@')[0];
    return this.accounts.socialLogin(provider,claims.sub,preferred || `${provider}-user`,email);
  }
}
