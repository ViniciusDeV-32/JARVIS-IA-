const http = require('http');
const OpenAI = require('openai');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.JARVIS_MODEL || 'gpt-5.6';
const VOICE = process.env.JARVIS_VOICE || 'onyx';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1000000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function askJarvis(message) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no Render.');
  }

  const response = await openai.responses.create({
    model: MODEL,
    instructions:
      'Você é JARVIS, um assistente pessoal inteligente. Responda em português do Brasil, de forma natural, objetiva e educada. Não diga que você é o ChatGPT; apresente-se como JARVIS.',
    input: message
  });

  return response.output_text;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return sendJson(res, 200, {
        status: 'online',
        name: 'JARVIS IA',
        model: MODEL,
        voice: VOICE,
        endpoints: ['/chat', '/voice']
      });
    }

    if (req.method === 'POST' && req.url === '/chat') {
      const body = JSON.parse(await readBody(req));
      const message = body.message;

      if (!message || typeof message !== 'string') {
        return sendJson(res, 400, { error: 'Envie { "message": "..." }' });
      }

      const reply = await askJarvis(message);
      return sendJson(res, 200, { reply, model: MODEL });
    }

    if (req.method === 'POST' && req.url === '/voice') {
      const body = JSON.parse(await readBody(req));
      const message = body.message;

      if (!message || typeof message !== 'string') {
        return sendJson(res, 400, { error: 'Envie { "message": "..." }' });
      }

      const reply = await askJarvis(message);

      const audio = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: VOICE,
        input: reply,
        instructions: 'Fale em português do Brasil, com voz masculina, calma, confiante e tecnológica, como um assistente pessoal futurista.',
        response_format: 'mp3'
      });

      const buffer = Buffer.from(await audio.arrayBuffer());
      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', buffer.length);
      return res.end(buffer);
    }

    return sendJson(res, 404, { error: 'Rota não encontrada' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      error: 'Erro no JARVIS',
      message: error.message
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JARVIS rodando na porta ${PORT}`);
});
