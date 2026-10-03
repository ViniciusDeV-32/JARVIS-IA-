const http = require('http');

const PORT = process.env.PORT || 3000;

const configuredModel = process.env.JARVIS_MODEL || 'gemini-2.5-flash-lite';
const MODEL = configuredModel.startsWith('gemini-')
  ? configuredModel
  : 'gemini-2.5-flash-lite';

const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || '';

const conversations = new Map();
const MAX_HISTORY_MESSAGES = 12;

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

async function askJarvis(message, sessionId = null) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada no Render.');
  }

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(MODEL) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const history = sessionId
    ? (conversations.get(sessionId) || [])
    : [];

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{ text: message }]
    }
  ];

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text:
            'Você é JARVIS, um assistente pessoal inteligente. ' +
            'Responda em português do Brasil, de forma natural, objetiva, ' +
            'educada e adequada para ser falada pela Alexa. ' +
            'Não diga que você é Gemini ou ChatGPT; apresente-se como JARVIS. ' +
            'Mantenha o contexto da conversa. ' +
            'Entenda perguntas de continuação como "e ele?", ' +
            '"quando foi isso?", "e depois?", "quanto?", "onde?" e semelhantes. ' +
            'Não repita desnecessariamente informações que já foram dadas.'
        }]
      },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Gemini error:', JSON.stringify(data));
    throw new Error(
      data?.error?.message ||
      'Erro ao consultar o Gemini.'
    );
  }

  const reply = data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim();

  if (!reply) {
    throw new Error('O Gemini não retornou uma resposta.');
  }

  if (sessionId) {
    const updatedHistory = [
      ...contents,
      {
        role: 'model',
        parts: [{ text: reply }]
      }
    ];

    conversations.set(
      sessionId,
      updatedHistory.slice(-MAX_HISTORY_MESSAGES)
    );
  }

  return reply;
}

function alexaResponse(text, endSession = true) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text: text.slice(0, 8000)
      },
      shouldEndSession: endSession
    }
  };
}

function verifyAlexaRequest(body) {
  if (!ALEXA_SKILL_ID) {
    return true;
  }

  return body?.session?.application?.applicationId === ALEXA_SKILL_ID;
}

async function handleAlexa(body) {
  if (!verifyAlexaRequest(body)) {
    const error = new Error('Alexa Skill ID inválido.');
    error.statusCode = 403;
    throw error;
  }

  const request = body.request || {};
  const sessionId = body.session?.sessionId || null;

  if (request.type === 'LaunchRequest') {
    if (sessionId) {
      conversations.set(sessionId, []);
    }

    return alexaResponse(
      'Olá. Eu sou o JARVIS. Estou pronto. Pode falar.',
      false
    );
  }

  if (request.type === 'SessionEndedRequest') {
    if (sessionId) {
      conversations.delete(sessionId);
    }

    return {
      version: '1.0',
      response: {}
    };
  }

  if (request.type === 'IntentRequest') {
    const intentName = request.intent?.name;

    if (
      intentName === 'AMAZON.StopIntent' ||
      intentName === 'AMAZON.CancelIntent'
    ) {
      if (sessionId) {
        conversations.delete(sessionId);
      }

      return alexaResponse('Até logo.', true);
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return alexaResponse(
        'Você pode me fazer qualquer pergunta. Por exemplo: qual é a capital do Brasil?',
        false
      );
    }

    if (intentName === 'JarvisIntent') {
      const slots = request.intent?.slots || {};

      const message =
        slots.question?.value ||
        slots.pergunta?.value ||
        slots.query?.value;

      if (!message) {
        return alexaResponse(
          'Claro. O que você gostaria de saber?',
          false
        );
      }

      const reply = await askJarvis(message, sessionId);

      return alexaResponse(reply, false);
    }
  }

  return alexaResponse(
    'Desculpe, não entendi. Pode perguntar novamente?',
    false
  );
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return sendJson(res, 200, {
        status: 'online',
        name: 'JARVIS IA',
        model: MODEL,
        endpoints: ['/chat', '/alexa']
      });
    }

    if (req.method === 'POST' && req.url === '/chat') {
      const body = JSON.parse(await readBody(req));
      const message = body.message;

      if (!message || typeof message !== 'string') {
        return sendJson(res, 400, {
          error: 'Envie { "message": "..." }'
        });
      }

      const reply = await askJarvis(message);
      return sendJson(res, 200, {
        reply,
        model: MODEL
      });
    }

    if (req.method === 'POST' && req.url === '/alexa') {
      const body = JSON.parse(await readBody(req));
      const response = await handleAlexa(body);
      return sendJson(res, 200, response);
    }

    return sendJson(res, 404, {
      error: 'Rota não encontrada'
    });
  } catch (error) {
    console.error(error);

    return sendJson(res, error.statusCode || 500, {
      error: 'Erro no JARVIS',
      message: error.message
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('JARVIS rodando na porta ' + PORT);
});
