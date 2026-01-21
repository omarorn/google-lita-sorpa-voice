import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionState } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audio';
import { Visualizer } from './components/Visualizer';

// Types
type LogMessage = {
  type: 'user' | 'model' | 'system';
  text: string;
  timestamp: number;
};

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

export default function App() {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [volume, setVolume] = useState(0); // For visualizer (0-1)
  const [textInput, setTextInput] = useState("");
  
  // Refs for audio handling to avoid re-renders
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null); // Type 'any' used because Session type isn't exported easily yet
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom of logs
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (type: 'user' | 'model' | 'system', text: string) => {
    setLogs(prev => [...prev, { type, text, timestamp: Date.now() }]);
  };

  const cleanup = useCallback(() => {
    // Close session
    if (sessionRef.current) {
      sessionRef.current = null;
    }

    // Stop microphone
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Close contexts
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    // Stop playing sources
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    sourcesRef.current.clear();
    
    scriptProcessorRef.current = null;
    outputNodeRef.current = null;
    nextStartTimeRef.current = 0;
    setVolume(0);
    setTextInput("");
  }, []);

  const handleConnect = async () => {
    try {
      setConnectionState(ConnectionState.CONNECTING);
      addLog('system', 'Frumstilli hljóðbúnað...');

      // 1. Initialize Audio Contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);
      outputNodeRef.current = outputNode;

      // 2. Get Microphone Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // 3. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      addLog('system', 'Tengist Gemini Live...');

      // Calculate dynamic date context for the model
      const now = new Date();
      const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
      const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
      const dateString = now.toLocaleDateString('is-IS', dateOptions);
      const timeString = now.toLocaleTimeString('is-IS', timeOptions);

      // 4. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }, // Friendly voice
          },
          systemInstruction: `Þú ert 'Litla Sorpa', snjall, hjálpsamur og vingjarnlegur sérfræðingur í flokkun sorps og endurvinnslu á Íslandi.
          Hlutverk þitt er að aðstoða notendur við að flokka rusl í réttar tunnur hjá 'Litlu Gámaleigunni'.

          Í dag er ${dateString} og klukkan er ${timeString}.

          Þú hefur djúpa þekkingu á íslenskum hátíðisdögum og frídögum (sbr. dagarnir.is).
          Vertu meðvitaður um að sorphirða og opnunartímar gámastöðva geta breyst á rauðum dögum (t.d. jólum, páskum, 17. júní, frídögum verslunarmanna).
          Ef dagurinn í dag er frídagur eða nálægt stórhátíð, minntu notandann kurteisislega á að athuga opnunartíma ef við á.

          Reglur um samskipti:
          1. Talaðu alltaf eðlilega og blæbrigðaríka íslensku.
          2. Ef notandinn talar annað tungumál, svaraðu á því máli.
          3. Vertu stuttorður og hnitmiðaður í svörum (talað mál), en vertu samt hlýlegur.
          4. Notaðu "við" þegar þú talar um Litlu Gámaleiguna.

          Sjónræn greining:
          Þú getur séð myndir sem notandinn sendir. Ef notandinn sendir mynd:
          1. Greindu hlutinn á myndinni nákvæmlega.
          2. Segðu notandanum í hvaða flokk hann fer (Plast, Pappi, Málmur, Gler, Lífrænt eða Almennt sorp).
          3. Ef hluturinn þarf sérstaka meðhöndlun (t.d. skola fernur, taka tappa af), taktu það fram.

          Gildir flokkar: Plast, Pappi, Málmur, Gler, Lífrænt, Almennt sorp.
          Ef þú ert ekki viss, biddu um nánari upplýsingar.`,
        },
        callbacks: {
          onopen: async () => {
            addLog('system', 'Tenging komin! Byrjaðu að tala.');
            setConnectionState(ConnectionState.CONNECTED);

            // Start Audio Processing Pipeline
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Simple volume meter for visualizer
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVolume(v => Math.max(rms * 5, v * 0.9)); // Smooth decay

              const pcmBlob = createBlob(inputData);
              
              // Send data when session is ready
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputNodeRef.current) {
              const ctx = outputAudioContextRef.current;
              
              // Sync start time
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              const audioBuffer = await decodeAudioData(
                decode(base64Audio),
                ctx,
                24000,
                1
              );

              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNodeRef.current);
              
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              
              // Visualizer feedback for output
              setVolume(0.5); // Pulse for AI talking
            }

            // Handle Turn Complete (Logging)
            if (message.serverContent?.turnComplete) {
              addLog('system', 'Svari lokið.');
              setVolume(0); // Reset volume when done
            }
            
            // Handle Interruption
            if (message.serverContent?.interrupted) {
               addLog('system', 'Gripið fram í.');
               sourcesRef.current.forEach(s => s.stop());
               sourcesRef.current.clear();
               nextStartTimeRef.current = 0;
            }
          },
          onclose: () => {
            addLog('system', 'Tengingu lokað.');
            setConnectionState(ConnectionState.DISCONNECTED);
            cleanup();
          },
          onerror: (err) => {
            console.error(err);
            addLog('system', 'Villa kom upp. Skoðaðu console.');
            setConnectionState(ConnectionState.ERROR);
            cleanup();
          }
        }
      });

      // Save session ref
      sessionRef.current = await sessionPromise;

    } catch (error) {
      console.error('Connection failed', error);
      addLog('system', 'Tenging mistókst.');
      setConnectionState(ConnectionState.ERROR);
      cleanup();
    }
  };

  const handleDisconnect = () => {
    cleanup();
    setConnectionState(ConnectionState.DISCONNECTED);
    addLog('system', 'Notandi endaði setu.');
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !sessionRef.current) return;

    try {
      addLog('system', 'Sendi mynd...');
      
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        // Remove data URL prefix (e.g. "data:image/jpeg;base64,")
        const base64Data = result.split(',')[1];
        
        // Send image to session
        sessionRef.current.sendRealtimeInput({
          media: {
            mimeType: file.type,
            data: base64Data
          }
        });
        
        addLog('user', 'Sendi mynd til greiningar');
        // Reset input
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      reader.readAsDataURL(file);
      
    } catch (error) {
      console.error("Image upload failed", error);
      addLog('system', 'Mistókst að senda mynd.');
    }
  };

  const handleSendText = () => {
    if (!textInput.trim() || !sessionRef.current) return;

    const text = textInput.trim();
    addLog('user', text);

    sessionRef.current.sendRealtimeInput({
      content: {
        role: 'user',
        parts: [{ text: text }]
      }
    });

    setTextInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSendText();
    }
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      
      {/* Background Decor */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none opacity-20">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500 rounded-full blur-3xl filter mix-blend-multiply animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-green-500 rounded-full blur-3xl filter mix-blend-multiply animate-pulse" style={{ animationDelay: '2s'}}></div>
      </div>

      <main className="relative z-10 w-full max-w-lg bg-slate-800/50 backdrop-blur-xl border border-slate-700 rounded-3xl p-8 shadow-2xl flex flex-col gap-6">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-700/50 border border-slate-600 text-xs font-medium text-slate-300">
            <span className={`w-2 h-2 rounded-full ${connectionState === ConnectionState.CONNECTED ? 'bg-green-400 animate-pulse' : 'bg-slate-400'}`}></span>
            {connectionState === ConnectionState.CONNECTED ? 'Bein tenging virk' : 'Tilbúin að tengjast'}
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Litla Sorpa</h1>
          <p className="text-slate-400">Spurðu mig hvar á að henda ruslinu.</p>
        </div>

        {/* Visualizer Area */}
        <div className="relative h-64 w-full flex items-center justify-center bg-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden shadow-inner">
          <Visualizer 
            isPlaying={connectionState === ConnectionState.CONNECTED} 
            volume={volume} 
          />
          
          {connectionState !== ConnectionState.CONNECTED && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 font-mono text-sm">
              Smelltu á 'Byrja samtal'...
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex justify-center gap-4">
          {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
            <button
              onClick={handleConnect}
              className="group relative inline-flex items-center justify-center px-8 py-4 font-semibold text-white transition-all duration-200 bg-blue-600 rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-600 focus:ring-offset-slate-900"
            >
              <span className="absolute inset-0 w-full h-full -mt-1 rounded-lg opacity-30 bg-gradient-to-b from-transparent via-transparent to-black"></span>
              <span className="relative flex items-center gap-3">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Byrja samtal
              </span>
            </button>
          ) : (
            <>
              <button
                onClick={handleDisconnect}
                className="inline-flex items-center justify-center px-6 py-4 font-semibold text-white transition-all duration-200 bg-red-500 rounded-full hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-600 focus:ring-offset-slate-900 shadow-lg shadow-red-500/30"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              
              <button
                onClick={triggerFileUpload}
                className="inline-flex items-center justify-center px-6 py-4 font-semibold text-white transition-all duration-200 bg-slate-700 rounded-full hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500 focus:ring-offset-slate-900 shadow-lg"
                title="Senda mynd"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleImageUpload} 
                className="hidden" 
                accept="image/*"
                capture="environment"
              />
            </>
          )}
        </div>

        {/* Text Input - Only visible when connected */}
        {connectionState === ConnectionState.CONNECTED && (
          <div className="flex gap-2 w-full animate-fade-in-up">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Skrifaðu skilaboð..."
              className="flex-1 bg-slate-700/50 border border-slate-600 rounded-full px-4 py-3 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
            <button
              onClick={handleSendText}
              disabled={!textInput.trim()}
              className="bg-blue-600 text-white rounded-full w-12 h-12 flex items-center justify-center hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-blue-500/25"
            >
              <svg className="w-5 h-5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        )}

        {/* Hints */}
        {connectionState !== ConnectionState.CONNECTED && (
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-700/30 p-3 rounded-xl border border-slate-700/50 text-center">
              <span className="block text-xs text-slate-500 uppercase tracking-wider mb-1">Prófaðu að spyrja</span>
              <p className="text-sm text-slate-300">"Hvert fer þessi pítsukassi?"</p>
            </div>
            <div className="bg-slate-700/30 p-3 rounded-xl border border-slate-700/50 text-center">
              <span className="block text-xs text-slate-500 uppercase tracking-wider mb-1">Prófaðu að spyrja</span>
              <p className="text-sm text-slate-300">"Er hægt að endurvinna gler?"</p>
            </div>
          </div>
        )}
      </main>

      {/* Logs (Hidden mostly, but useful context) */}
      <div className="fixed bottom-4 right-4 w-64 h-32 bg-slate-900/90 border border-slate-700 rounded-lg p-2 overflow-y-auto text-xs font-mono text-slate-400 opacity-50 hover:opacity-100 transition-opacity">
        {logs.map((log, i) => (
          <div key={i} className="mb-1">
            <span className={log.type === 'system' ? 'text-blue-400' : 'text-green-400'}>[{log.type}]</span> {log.text}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}