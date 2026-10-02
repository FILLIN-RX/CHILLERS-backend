import axios from 'axios';

export type AIProvider = 'openai' | 'gemini' | 'claude' | 'none';

const OPENAI_API_URL = 'https://api.openai.com/v1';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1';

export interface SpeechInput {
  titre: string;
  synopsis?: string;
  tagline?: string;
  type: 'movie' | 'series';
  year?: number;
}

export interface PosterInput {
  titre: string;
  synopsis?: string;
  type: 'movie' | 'series';
}

export function getAIProvider(): AIProvider {
  if (process.env.AI_PROVIDER === 'openai' && process.env.AI_OPENAI_KEY) return 'openai';
  if (process.env.AI_PROVIDER === 'gemini' && process.env.AI_GEMINI_KEY) return 'gemini';
  if (process.env.AI_PROVIDER === 'claude' && process.env.AI_CLAUDE_KEY) return 'claude';
  if (process.env.AI_OPENAI_KEY) return 'openai';
  if (process.env.AI_GEMINI_KEY) return 'gemini';
  if (process.env.AI_CLAUDE_KEY) return 'claude';
  return 'none';
}

export function getImageAIProvider(): 'openai' | 'gemini' | 'none' {
  if (process.env.AI_OPENAI_KEY) return 'openai';
  if (process.env.AI_GEMINI_KEY) return 'gemini';
  return 'none';
}

const SPEECH_PROMPT = (input: SpeechInput) =>
  `Rédige un court texte marketing de 2 à 3 phrases en français pour promouvoir le ${input.type === 'movie' ? 'film' : 'série'} « ${input.titre} »${input.year ? ` (${input.year})` : ''}.
Base-toi sur le synopsis suivant et le tagline si présent.
Le texte doit être percutant, accrocheur, sans spoiler, et donner envie de regarder. Ne mets ni guillemets, ni titre, ni intro.
${input.tagline ? `Tagline: ${input.tagline}` : ''}
Synopsis: ${input.synopsis || 'aucun'}`;

const POSTER_PROMPT = (input: PosterInput) =>
  `Crée une affiche de ${input.type === 'movie' ? 'film' : 'série'} professionnelle, style Hollywood, pour « ${input.titre} ».
${input.synopsis ? `Contexte: ${input.synopsis}` : ''}
Format portrait 2:3, aucun texte sur l'image, atmosphère cinématographique, éclairage dramatique, personnages en situation, qualité photoréaliste élevée.`;

export async function generateSpeech(input: SpeechInput): Promise<string | null> {
  const provider = getAIProvider();
  if (provider === 'none') return null;

  const prompt = SPEECH_PROMPT(input);

  try {
    if (provider === 'openai') {
      const { data } = await axios.post(
        `${OPENAI_API_URL}/chat/completions`,
        {
          model: process.env.AI_OPENAI_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          temperature: 0.8,
        },
        { headers: { Authorization: `Bearer ${process.env.AI_OPENAI_KEY}` }, timeout: 30000 },
      );
      return data.choices?.[0]?.message?.content?.trim() || null;
    }

    if (provider === 'gemini') {
      const { data } = await axios.post(
        `${GEMINI_API_URL}/models/${process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { params: { key: process.env.AI_GEMINI_KEY }, timeout: 30000 },
      );
      return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('').trim() || null;
    }

    if (provider === 'claude') {
      const { data } = await axios.post(
        `${CLAUDE_API_URL}/messages`,
        {
          model: process.env.AI_CLAUDE_MODEL || 'claude-3-5-haiku-latest',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'x-api-key': process.env.AI_CLAUDE_KEY,
            'anthropic-version': '2023-06-01',
          },
          timeout: 30000,
        },
      );
      return data?.content?.[0]?.text?.trim() || null;
    }
  } catch (err: any) {
    console.error(`[AI] Erreur génération speech (${provider}):`, err.response?.data || err.message);
  }
  return null;
}

export async function generatePosterImage(input: PosterInput): Promise<string | null> {
  const provider = getImageAIProvider();
  if (provider === 'none') return null;

  const prompt = POSTER_PROMPT(input);

  try {
    if (provider === 'openai') {
      const { data } = await axios.post(
        `${OPENAI_API_URL}/images/generations`,
        {
          model: process.env.AI_OPENAI_IMAGE_MODEL || 'gpt-image-1',
          prompt,
          n: 1,
          size: '1024x1536',
          response_format: 'b64_json',
        },
        { headers: { Authorization: `Bearer ${process.env.AI_OPENAI_KEY}` }, timeout: 120000 },
      );
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) return null;
      return await saveGeneratedImage(b64, `openai-${Date.now()}.png`);
    }

    if (provider === 'gemini') {
      const { data } = await axios.post(
        `${GEMINI_API_URL}/models/${process.env.AI_GEMINI_IMAGE_MODEL || 'imagen-3.0-generate-002'}:predict`,
        { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '2:3' } },
        { params: { key: process.env.AI_GEMINI_KEY }, timeout: 120000 },
      );
      const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
      if (!b64) return null;
      return await saveGeneratedImage(b64, `gemini-${Date.now()}.png`);
    }
  } catch (err: any) {
    console.error(`[AI] Erreur génération image (${provider}):`, err.response?.data || err.message);
  }
  return null;
}

async function saveGeneratedImage(base64: string, filename: string): Promise<string | null> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.join(__dirname, '../../../uploads/ai-posters');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return `/uploads/ai-posters/${filename}`;
  } catch (err: any) {
    console.error('[AI] Erreur sauvegarde image générée:', err.message);
    return null;
  }
}
