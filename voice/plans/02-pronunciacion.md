# Plan 2 — Práctica inversa: leo o respondo, y Azure evalúa pronunciación y tono

Objetivo: practicar textos y respuestas en voz alta y saber, con datos, qué palabras y
sonidos fallan y si la entonación y el ritmo son adecuados para una entrevista.

Se construye sobre la arquitectura del [Plan 1](01-tts-preguntas.md): módulo `voice/`
propio del fork, `config/voice.yml`, claves en `.env`, skill `interview-voice` y regla en
`modes/_custom.md`.

---

## 1. Dos ejercicios

| Ejercicio | Qué haces | Qué devuelve Azure |
|---|---|---|
| **A. Lectura con guion** (`drill`) | Lees un texto conocido: tu respuesta preparada, la "versión mejorada" del feedback de `interview/practice`, o cualquier texto de `interview-prep/`. Opcionalmente lo oyes antes con la voz TTS del Plan 1 (shadowing). | Precisión, fluidez, integridad (palabras omitidas o añadidas), prosodia, y puntuación por palabra y por fonema. |
| **B. Respuesta libre** (sin guion) | Respondes hablando a la pregunta de la entrevista simulada. | Transcripción + precisión, fluidez y prosodia. La transcripción se usa como **tu respuesta** en `interview/practice`, así que una sola grabación da el feedback de contenido y el de pronunciación. |

## 2. Qué significa aquí "tono adecuado"

**Lo que Azure mide:**
- **Prosodia** (`ProsodyScore`): acento de palabra, entonación y ritmo. Por palabra marca
  errores `Monotone` (entonación plana; se evalúa sobre toda la frase), `UnexpectedBreak`
  (pausa donde no toca) y `MissingBreak` (falta una pausa). Una nota de Microsoft dice que
  la versión actual podría no devolver los errores de pausa: hay que verificarlo en la
  prueba rápida.
- **Fluidez** (`FluencyScore`): pausas y continuidad.

**Lo que calculamos nosotros** a partir de los tiempos de cada palabra:
- velocidad en palabras por minuto;
- pausas largas (> 1 s), con la palabra tras la que ocurren;
- duración total, para la regla de los 2 minutos de `interview/practice`.

**Lo que no mide nadie:** si suenas seguro o convencido. El agente lo valora sobre la
transcripción (rodeos del tipo "I think maybe…", frases sin cerrar), y se presenta como
opinión, no como medida.

Según una fuente de terceros (sin confirmar en la documentación oficial), la prosodia
solo existe en `en-US`. Es el motivo principal para usar `en-US` como acento de
evaluación.

## 3. Restricciones técnicas

- **REST de audio corto:** la evaluación de pronunciación admite como máximo **30 s** de
  audio. Basta para drills de 1–3 frases.
- **Respuestas de entrevista** (1–2 min): hace falta el **SDK de Speech en modo continuo**
  leyendo un WAV (`microsoft-cognitiveservices-speech-sdk` en `voice/package.json`, sin
  tocar el del core). En Node, el SDK lee archivos de audio, no el micrófono.
- **Formato:** WAV PCM, 16 kHz, mono, 16 bits.
- **Grabación:** el agente no puede grabar, así que lo hace `voice.mjs record` lanzando
  `sox` (`rec`) con detección de silencio:

  ```
  rec -q -r 16000 -c 1 -b 16 <salida.wav> silence 1 0.1 1% 1 3.0 1% trim 0 150
  ```

  Empieza cuando hablas, para tras unos 3 s de silencio y corta a los 150 s. Funciona
  desde la herramienta Bash del agente sin pulsar teclas. El umbral (`1%`) y la pausa
  final (`3.0`) se ajustan en `config/voice.yml`, porque dependen del micro y del ruido.
- **Alternativas de grabación:**
  - `ffmpeg`, con dispositivo distinto en cada sistema operativo;
  - grabar con el móvil, soltar el archivo en `output/voice/inbox/` y ejecutar `assess
    --audio`, que lo convierte a WAV 16 kHz con ffmpeg.
- **macOS:** la app de terminal necesita permiso de micrófono (Ajustes del Sistema →
  Privacidad y seguridad → Micrófono). `doctor` lo detecta si `rec` graba silencio.
- **Hosts permitidos:** añadir `{region}.stt.speech.microsoft.com` a la lista del Plan 1.
- **Privacidad:** tu voz se envía a Azure para evaluarla. Las grabaciones quedan en
  `output/voice/recordings/`, que no se sube a git. Con `keep_recordings: false` se borran
  tras evaluar.

## 4. Comandos (se añaden a `voice.mjs`)

| Comando | Hace |
|---|---|
| `record --out <wav> [--max 150]` | Graba con detección de silencio. |
| `assess --audio <wav> [--reference-file <txt>] [--locale en-US]` | Con `--reference-file`: modo guion (detecta omisiones e inserciones). Sin él: modo libre (devuelve transcripción). Elige solo REST (≤ 30 s) o SDK continuo (> 30 s). |
| `drill --reference-file <txt> [--listen-first]` | Opcionalmente oye el modelo TTS, luego graba, evalúa y resume. Ejercicio de repetición. |
| `progress [--since 30d]` | Evolución media por métrica, y palabras y fonemas que más fallan. Es para ver avances y ganar confianza. |

**Salida de `assess`:** un JSON resumido, no el JSON crudo de Azure, que es enorme. Se
guarda en `output/voice/assessments/{fecha}-{slug}.json`:

```json
{
  "mode": "scripted",
  "locale": "en-US",
  "transcript": "…",
  "scores": { "pronunciation": 82, "accuracy": 85, "fluency": 78, "completeness": 95, "prosody": 70 },
  "timing": { "duration_s": 94, "wpm": 138, "long_pauses": [{ "after": "project", "s": 1.8 }] },
  "words_to_fix": [
    { "word": "through", "accuracy": 42, "error": "Mispronunciation",
      "worst_phonemes": [{ "phoneme": "θ", "score": 20 }] }
  ],
  "prosody_flags": [{ "word": "interested", "type": "Monotone" }],
  "omitted": [], "inserted": []
}
```

- **Parámetros para Azure:**
  - `GradingSystem: HundredMark`
  - `Granularity: Phoneme`
  - `EnableMiscue: true` (solo con guion)
  - prosodia activada
  - alfabeto de fonemas IPA (por defecto Azure usa su notación americana; IPA parece
    disponible al menos en en-US, hay que verificarlo)
- **Umbrales orientativos**, ajustables en el YAML:
  - palabra a corregir si su precisión < 60;
  - aviso de prosodia si < 70;
  - aviso de ritmo si la velocidad sale de 120–160 palabras por minuto;
  - un máximo de **3 palabras a corregir por respuesta**, para no abrumar. El objetivo es
    que se te entienda, no sonar nativo.

## 5. Integración con `interview/practice`

Ampliación de la regla de `modes/_custom.md` del Plan 1, con un ajuste nuevo
`answer_mode: spoken | typed` en `config/voice.yml`:

> Si `answer_mode: spoken`: tras leer la pregunta, ejecuta `record` y luego `assess` sin
> guion. Enseña la transcripción y deja que la corrija ("corrige: …") antes de evaluar el
> contenido, porque un error de transcripción no es un fallo mío. Usa la transcripción
> corregida como mi respuesta, también en la transcripción de sesión. Al feedback normal
> añade un bloque **Pronunciación y tono** y, después, ofrece un drill de lectura de la
> versión mejorada.

**Formato del bloque:**

```markdown
**Pronunciación y tono** (Azure: global 82 · fluidez 78 · prosodia 70 · 138 ppm)
- "through" → la "th" sonó como /t/; es /θ/: punta de la lengua entre los dientes, sin voz.
- "focused" → la -ed final se pronuncia /t/, no /ed/.
- Entonación: plana en el cierre ("…and that's why I'm interested"); baja el tono al
  final para sonar seguro.
```

- **Reparto:** Azure da las puntuaciones; el agente las traduce a pistas en español. Cada
  pista debe partir de un dato de Azure (palabra y fonema concretos), no de suposiciones.
- **Transcripción de sesión:** `interview-prep/sessions/` no cambia de formato. Los
  resultados de pronunciación van a `output/voice/assessments/`, para no romper el
  contrato que leen otros modos.
- **Fuera de una entrevista:** `/interview-voice drill` con cualquier texto, por ejemplo
  tus respuestas de "walk me through your background" o "why this company".

## 6. Coste

- **Plan gratuito F0:** 5 horas de audio al mes de reconocimiento. Con respuestas de
  2 minutos, unas 150 respuestas al mes.
- **Por confirmar en la prueba rápida:** si la evaluación de pronunciación funciona en F0,
  y su precio en el plan de pago. Las fuentes discrepan: +0,30 $/hora o incluida.
- **Contador:** los segundos de audio se suman en `data/voice-usage.tsv`, igual que los
  caracteres del Plan 1.

## 7. Pasos de implementación

1. **Prueba rápida (1 h):** grabar un WAV de unos 20 s y enviarlo por REST con y sin texto
   de referencia, con prosodia y con IPA. Apuntar qué campos devuelve de verdad F0
   (prosodia, errores de pausa, fonemas) y ajustar el resumen a eso. Guardar la respuesta
   como fixture de tests (sin datos personales).
2. `record` con sox y silencio, por sistema operativo; `doctor` comprueba `rec` y que
   graba algo audible.
3. `assess` por REST (≤ 30 s) + resumen + tests con la fixture, sin red.
4. Modo continuo con el SDK para > 30 s, con el mismo resumen.
5. `drill` (con `--listen-first` usando `say` del Plan 1) y `progress`.
6. Regla en `_custom.md`, sección nueva del skill y prueba real con 3 preguntas en
   `answer_mode: spoken`.

## 8. Criterios de aceptación

- Un drill de 2–3 frases devuelve puntuaciones y como mucho 3 palabras a corregir, con el
  fonema que falla.
- Una respuesta libre de 90 s se graba sola (para con el silencio), se transcribe y se
  evalúa.
- En `interview/practice` con voz, una grabación produce a la vez el feedback de contenido
  y el bloque de pronunciación y tono.
- La transcripción se puede corregir antes del feedback de contenido.
- `progress` muestra la evolución tras varias sesiones.
- Ninguna grabación ni clave entra en git; `node test-all.mjs` sigue pasando.

## 9. Riesgos

- **Ruido de fondo** → puntuaciones bajas injustas. Usa auriculares con micro.
- **Errores de transcripción** en modo libre → la transcripción es corregible (§5).
- **Prosodia solo en en-US** (sin confirmar) → si practicas en-GB, ese bloque no saldría.
- **Puntuar contra un modelo nativo** empuja a perseguir el 100. Los umbrales y el máximo
  de 3 correcciones mantienen el foco en lo que de verdad se entiende mal.

## 10. Decisiones pendientes

- **Sistema operativo:** decide cómo se instala `sox` (brew / apt / choco) y el aviso del
  permiso de micrófono.
- **Grabación:** `sox` (recomendado) o archivo grabado con el móvil.
- **`answer_mode` por defecto:** `spoken` o `typed`.
- **¿Guardar las grabaciones?** Por defecto no (`keep_recordings: false`).
