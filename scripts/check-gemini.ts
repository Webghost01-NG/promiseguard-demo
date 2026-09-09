import { Providers } from '../server/providers.ts';
const provider = new Providers();
const model = process.argv[2];
if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Pass one model ID to check.');
try {
  const result = await provider.request('Gemini', `/models/${model}:generateContent`, 'POST', {
    contents: [{ parts: [{ text: 'API connectivity check. Return {"ready":true} as JSON. No external task was performed.' }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { ready: { type: 'BOOLEAN' } }, required: ['ready'] }, maxOutputTokens: 1024 },
  });
  console.log(JSON.stringify({ model, finishReason: result.candidates?.[0]?.finishReason, text: result.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text).join('') }));
} catch (error) { console.log((error as Error).message); process.exitCode = 1; }
