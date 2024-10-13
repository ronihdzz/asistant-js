import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

// Obtener la clave API de OpenAI desde las variables de entorno
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Falta la clave API de OpenAI. Por favor, configúrela en el archivo .env.');
    process.exit(1);
}

// Inicializar Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constantes
const SYSTEM_MESSAGE = 'Eres un recepcionista AI para Barts Automotive. Tu trabajo es interactuar educadamente con el cliente y obtener su nombre, disponibilidad y el servicio/trabajo requerido. Haz una pregunta a la vez. No pidas otra información de contacto y no verifiques disponibilidad, asume que estamos libres. Asegúrate de que la conversación sea amigable y profesional, y guía al usuario para que proporcione estos detalles de manera natural. Si es necesario, haz preguntas de seguimiento para recopilar la información requerida.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const WEBHOOK_URL = "<introduce tu URL de webhook aquí>";

// Gestión de sesiones
const sessions = new Map();

// Lista de tipos de eventos para registrar en la consola
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'response.text.done',
    'conversation.item.input_audio_transcription.completed'
];

// Ruta raíz
fastify.get('/', async (request, reply) => {
    reply.send({ message: '¡El servidor de Twilio Media Stream está en funcionamiento!' });
});

// Ruta para que Twilio maneje llamadas entrantes y salientes
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Llamada entrante');

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Hola, has llamado al Centro Automotriz de Bart. ¿Cómo podemos ayudarte?</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// Ruta WebSocket para media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Cliente conectado');

        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || { transcript: '', streamSid: null };
        sessions.set(sessionId, session);

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: {
                        "model": "whisper-1"
                    }
                }
            };

            console.log('Enviando actualización de sesión:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Evento de apertura para WebSocket de OpenAI
        openAiWs.on('open', () => {
            console.log('Conectado a la API Realtime de OpenAI');
            setTimeout(sendSessionUpdate, 250);
        });

        // Escuchar mensajes del WebSocket de OpenAI
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Evento recibido: ${response.type}`, response);
                }

                // Manejo de transcripción de mensajes del usuario
                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    const userMessage = response.transcript.trim();
                    session.transcript += `Usuario: ${userMessage}\n`;
                    console.log(`Usuario (${sessionId}): ${userMessage}`);
                }

                // Manejo de mensajes del agente
                if (response.type === 'response.done') {
                    const agentMessage = response.response.output[0]?.content?.find(content => content.transcript)?.transcript || 'Mensaje del agente no encontrado';
                    session.transcript += `Agente: ${agentMessage}\n`;
                    console.log(`Agente (${sessionId}): ${agentMessage}`);
                }

                if (response.type === 'session.updated') {
                    console.log('Sesión actualizada con éxito:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: session.streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error al procesar el mensaje de OpenAI:', error, 'Mensaje sin procesar:', data);
            }
        });

        // Manejar mensajes entrantes de Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        session.streamSid = data.start.streamSid;
                        console.log('El flujo entrante ha comenzado', session.streamSid);
                        break;
                    default:
                        console.log('Evento no relacionado con medios recibido:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error al analizar el mensaje:', error, 'Mensaje:', message);
            }
        });

        // Manejar cierre de conexión y registrar transcripción
        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log(`Cliente desconectado (${sessionId}).`);
            console.log('Transcripción completa:');
            console.log(session.transcript);

            await processTranscriptAndSend(session.transcript, sessionId);

            // Limpiar la sesión
            sessions.delete(sessionId);
        });

        // Manejar cierre y errores del WebSocket
        openAiWs.on('close', () => {
            console.log('Desconectado de la API Realtime de OpenAI');
        });

        openAiWs.on('error', (error) => {
            console.error('Error en el WebSocket de OpenAI:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`El servidor está escuchando en el puerto ${PORT}`);
});

// Función para realizar la llamada de finalización de la API de ChatGPT con salidas estructuradas
async function makeChatGPTCompletion(transcript) {
    console.log('Iniciando llamada a la API de ChatGPT...');
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "gpt-4o-2024-08-06",
                messages: [
                    { "role": "system", "content": "Extrae los detalles del cliente: nombre, disponibilidad y cualquier nota especial de la transcripción." },
                    { "role": "user", "content": transcript }
                ],
                response_format: {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "customer_details_extraction",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "customerName": { "type": "string" },
                                "customerAvailability": { "type": "string" },
                                "specialNotes": { "type": "string" }
                            },
                            "required": ["customerName", "customerAvailability", "specialNotes"]
                        }
                    }
                }
            })
        });

        console.log('Estado de la respuesta de la API de ChatGPT:', response.status);
        const data = await response.json();
        console.log('Respuesta completa de la API de ChatGPT:', JSON.stringify(data, null, 2));
        return data;
    } catch (error) {
        console.error('Error al realizar la llamada de finalización de ChatGPT:', error);
        throw error;
    }
}

// Función para enviar datos al webhook de Make.com
async function sendToWebhook(payload) {
    console.log('Enviando datos al webhook:', JSON.stringify(payload, null, 2));
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        console.log('Estado de la respuesta del webhook:', response.status);
        if (response.ok) {
            console.log('Datos enviados con éxito al webhook.');
        } else {
            console.error('Error al enviar datos al webhook:', response.statusText);
        }
    } catch (error) {
        console.error('Error al enviar datos al webhook:', error);
    }
}

// Función principal para extraer y enviar detalles del cliente
async function processTranscriptAndSend(transcript, sessionId = null) {
    console.log(`Iniciando procesamiento de transcripción para la sesión ${sessionId}...`);
    try {
        // Realizar la llamada de finalización de ChatGPT
        const result = await makeChatGPTCompletion(transcript);

        console.log('Resultado sin procesar de ChatGPT:', JSON.stringify(result, null, 2));

        if (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
            try {
                const parsedContent = JSON.parse(result.choices[0].message.content);
                console.log('Contenido analizado:', JSON.stringify(parsedContent, null, 2));

                if (parsedContent) {
                    // Enviar el contenido analizado directamente al webhook
                    await sendToWebhook(parsedContent);
                    console.log('Detalles del cliente extraídos y enviados:', parsedContent);
                } else {
                    console.error('Estructura JSON inesperada en la respuesta de ChatGPT');
                }
            } catch (parseError) {
                console.error('Error al analizar JSON de la respuesta de ChatGPT:', parseError);
            }
        } else {
            console.error('Estructura de respuesta inesperada de la API de ChatGPT');
        }

    } catch (error) {
        console.error('Error en processTranscriptAndSend:', error);
    }
}