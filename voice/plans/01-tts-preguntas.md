# Plan 1 — Preguntas de entrevista con voz (Azure TTS)

Objetivo: durante `/career-ops interview/practice`, cada pregunta (y cada repregunta) se
oye en voz alta con la voz, el idioma y el tono configurados. También se puede usar
suelto, fuera de una sesión.

Este plan incluye la arquitectura común. El [Plan 2](02-pronunciacion.md) (leer yo y que
Azure me evalúe) se construye encima.

---

## 1. Qué permite career-ops hoy

Revisado en el código de la v1.38.0:

| Pieza | ¿Sirve? | Por qué |
|---|---|---|
| **Skills nuevos** | Sí, pero fuera de `.claude/skills/` | Claude Code carga cualquier `SKILL.md` de `.claude/skills/<nombre>/` (del proyecto) o de `~/.claude/skills/<nombre>/` (personal). Pero `.claude/skills/` y `.agents/` son **rutas de sistema**, y el actualizador **se niega** a protegerlas en `config/local-paths.txt` (comprobado: *"refusing .claude/skills/interview-voice/ — the system layer ships it"*). Por eso el skill vive en `voice/skill/` y se instala en la carpeta personal (ver §7). |
| **Añadir un modo al router** (`/career-ops voice`) | No sin tocar sistema | La tabla de modos vive en `.agents/skills/career-ops/SKILL.md`, que se sobrescribe al actualizar. |
| **Enganche en `interview/practice`** | Sí | El router carga `modes/_custom.md` (capa de usuario) antes de `interview/practice`. Una regla de casa ahí activa la voz. |
| **Plugins** (`plugins/`, `plugins.local/`) | Solo en parte | Leen ajustes no secretos de `config/plugins.yml` y claves de `.env`, y pueden traer su propio skill (`node plugins.mjs skill <id>`). **Pero:** solo admiten 5 tipos de hook (`provider`, `ingest`, `search`, `notify`, `export`) y ninguno es "hablar" ni "evaluar audio"; cada hook se corta a los 15 s; `test-all.mjs` prohíbe a los plugins de `plugins/` importar `child_process`, así que no podrían reproducir ni grabar; y `plugins/_engine.mjs` es archivo de sistema, así que un cambio en el motor desaparece en la siguiente actualización. |

## 2. Decisión

**Fase A (ahora, en el fork):** un módulo propio `voice/` con **forma de plugin** pero
fuera del motor de plugins:

- ajustes en un YAML de usuario (`config/voice.yml`), con voz, idioma y tono;
- claves en `.env`;
- lista fija de hosts permitidos;
- skill propio;
- no toca ningún archivo de sistema.

**Fase B (opcional, más adelante):** proponer upstream un tipo de hook `speech`.
CONTRIBUTING pide primero issue y discusión. Si se acepta, se porta el cliente de red a
`plugins/azure-speech/`, con ajustes en `config/plugins.yml` y `skill.md`. Reproducir y
grabar seguiría fuera del plugin, porque los plugins no pueden lanzar procesos.

Descartado: usar el hook `notify` para TTS. Sería un apaño que no aguanta una revisión, y
la evaluación de pronunciación (Plan 2) no cabe en ningún hook.

## 3. Estructura de archivos

```
voice/                              # propio del fork → declarar en config/local-paths.txt
  package.json                      # dependencias propias; no toca el package.json del core
  voice.example.yml                 # plantilla de ajustes → copiar a config/voice.yml
  voice.mjs                         # CLI: doctor | voices | say   (Plan 2 añade record | assess | drill | progress)
  lib/config.mjs                    # lee config/voice.yml + .env del data root y valida
  lib/azure-tts.mjs                 # construye el SSML, llama a la REST de TTS y a voices/list
  lib/player.mjs                    # detecta el reproductor según el sistema operativo
  lib/usage.mjs                     # contador de caracteres / segundos de audio del mes
  test/voice.test.mjs               # tests sin red (SSML, escapado, config, caché)
  skill/SKILL.md                    # fuente del skill interview-voice (versionada en el fork)
  plans/                            # estos planes
config/voice.yml                    # tus ajustes (capa de usuario; sin secretos)
config/local-paths.txt              # declara voice/ como propio del fork (§7)
.env                                # AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (ya está en .gitignore)
modes/_custom.md                    # regla de casa que activa la voz en interview/practice
~/.claude/skills/interview-voice/   # copia instalada del skill (fuera del repo)
```

`voice.mjs` resuelve el data root con `getCareerOpsRoot()` de `path-resolver.mjs`, como
pide AGENTS.md para scripts nuevos. Así encuentra `config/voice.yml`, `.env` y `output/`
aunque los datos vivan fuera del checkout.

## 4. Ajustes: voz, idioma y tono

`config/voice.yml`:

```yaml
voice:
  enabled: true
  locale: en-US                  # idioma/acento de las preguntas (en-US, en-GB, en-IN, es-ES…)
  voice: en-US-JennyNeural       # cualquier voz de `node voice/voice.mjs voices --locale en-US`
  style: friendly                # TONO: estilo mstts:express-as; solo si la voz lo admite
  style_degree: 1.0              # intensidad del estilo, 0.01–2
  rate: "-5%"                    # velocidad; negativo = más despacio
  pitch: default                 # tono de voz (altura): "+5%", "-2st", default…
  show_text: true                # false = modo escucha: la pregunta no se muestra escrita
  player: auto                   # auto | afplay | aplay | paplay | ffplay | powershell
  cache: true                    # no volver a pagar la misma pregunta
  monthly_char_budget: 450000    # aviso antes de agotar los 500.000 gratis del plan F0

  # Tono según el entrevistador simulado (interview/practice ya define el tipo de ronda)
  personas:
    recruiter:      { voice: en-US-JennyNeural, style: friendly, rate: "0%" }
    hiring-manager: { voice: en-US-GuyNeural,   style: null,     rate: "-5%" }
    panel:          { voice: en-GB-RyanNeural,  style: null,     rate: "0%" }   # practicar otro acento
```

- **Idioma:** `locale` + `voice`. Si el texto de la pregunta está en otro idioma que la
  voz, `say` avisa; las voces *Multilingual* lo leen igualmente.
- **Tono:** `style` + `style_degree` (carácter: amable, neutro, serio…), `rate` y `pitch`.
  Los estilos disponibles **dependen de cada voz**: no se escriben a mano en el código,
  se validan contra `voices/list` (campo `StyleList`). Si un estilo no está disponible,
  `say` avisa y lo omite, sin fallar.
- Los nombres de voz y estilo del ejemplo son orientativos; `doctor` comprueba que
  existen en tu región.

## 5. Comandos

| Comando | Hace |
|---|---|
| `node voice/voice.mjs doctor` | Comprueba la clave y la región, que la voz y el estilo existen, que hay reproductor, y cuánto presupuesto del mes queda. |
| `node voice/voice.mjs voices --locale en-US [--styles]` | Lista voces y estilos disponibles. |
| `node voice/voice.mjs say --text-file <ruta> [--persona recruiter] [--no-play]` | Sintetiza, guarda en `output/voice/cache/<hash>.wav` y reproduce. |

El texto entra **por archivo, no como argumento**. Las preguntas pueden venir de ofertas
(contenido externo no fiable), y AGENTS.md ya prohíbe meter ese texto en un comando de
shell. El agente escribe la pregunta en `output/voice/tmp/question.txt` con su
herramienta de archivos y llama a `say`.

## 6. Detalles técnicos

- **REST de TTS:** `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`
  - Cabeceras: `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`,
    `X-Microsoft-OutputFormat: riff-24khz-16bit-mono-pcm`.
  - Salida en **WAV**, no mp3: la reproducen todos los sistemas sin instalar nada, incluido
    `Media.SoundPlayer` de Windows.
- **Voces:** `GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list`.
  Se cachea 7 días en `output/voice/voices.json`.
- **SSML:**
  - escapar `& < > " '` del texto, para que una pregunta con `<` o `&` no rompa el SSML ni
    inyecte etiquetas;
  - `<mstts:express-as style styledegree>` solo si la voz admite el estilo;
  - `<prosody rate pitch>` para velocidad y altura.
- **Hosts permitidos:** solo `{region}.tts.speech.microsoft.com`. Hay que fijarlo en el
  cliente, igual que `allowedHosts` en los plugins.
- **Caché:** clave = hash(texto + voz + estilo + grado + rate + pitch). Las preguntas del
  banco se repiten entre sesiones, así que no se paga dos veces.
- **Presupuesto:** `data/voice-usage.tsv` (fecha, operación, caracteres o segundos) y
  aviso al 90 % de `monthly_char_budget`. Según fuentes de terceros, F0 da 500.000
  caracteres al mes y unas 20 peticiones por minuto; confírmalo en el portal de Azure.
- **Errores:**
  - 401: clave o región incorrectas, con un mensaje claro;
  - 429: un reintento con espera;
  - 400: muestra qué SSML se rechazó.
- **Secretos:** la clave nunca se imprime ni se escribe en logs.
- **Reproductor por sistema:**

  | Sistema | Reproductor |
  |---|---|
  | macOS | `afplay` |
  | Linux | `aplay`, `paplay` o `ffplay -nodisp -autoexit` |
  | Windows | PowerShell `(New-Object Media.SoundPlayer '<wav>').PlaySync()` |

  `player:` en el YAML lo fuerza.

## 7. Integración con career-ops

1. **Skill** `voice/skill/SKILL.md`, versionado en el fork:
   - **Descripción:** se activa con "lee la pregunta en voz alta", "modo voz" o "practicar
     escuchando".
   - **Al empezar:** `doctor` una vez por sesión. Si falla, lo dice una vez y sigue en texto.
   - **Por cada pregunta:** escribir el texto en el archivo temporal, ejecutar `say` con la
     persona de la sesión y esperar la respuesta.
   - **No leer el feedback en voz alta** salvo que se pida: el feedback es largo y se lee
     mejor.
   - **Instalación:** `node voice/voice.mjs install-skill` lo copia a
     `~/.claude/skills/interview-voice/SKILL.md`, la carpeta de skills personales de Claude
     Code. El actualizador de career-ops nunca la toca. Hay que volver a ejecutarlo cuando
     cambie el skill.
2. **Regla en `modes/_custom.md`** (capa de usuario, sobrevive a las actualizaciones). Se
   remite a `voice/skill/SKILL.md`, así que funciona en **cualquier CLI** aunque el skill
   no esté instalado:

   > **Voz en entrevistas simuladas.** En `interview/practice`, si `config/voice.yml` tiene
   > `enabled: true`, lee `voice/skill/SKILL.md` y úsalo para leer cada pregunta y
   > repregunta en voz alta, con la persona que encaje con la ronda (recruiter,
   > hiring-manager o panel). Muestra el texto de la pregunta solo si `show_text: true`.
   > Si la voz falla, sigue por texto y dilo una vez.

3. **Cómo se lanza:**
   - `/career-ops interview/practice`: la voz se activa sola por la regla.
   - `/interview-voice` (con el skill instalado): para oír un texto suelto.
4. **Protección frente a actualizaciones.** `config/local-paths.txt` con una sola línea:

   ```
   voice/
   ```

   Comprobado: el actualizador lo acepta y el validador de cobertura deja de marcar
   `voice/` como huérfano. Ese archivo está en `.gitignore`. Si tu fork pasa los tests en
   CI, sigue la receta de `config/local-paths.example.txt`: añadir
   `!config/local-paths.txt` al final de `.gitignore` y versionarlo.

## 8. Pasos de implementación

1. **Prueba rápida (30 min):** con tu clave, llamar a `voices/list` y sintetizar una frase.
   Confirmar la región, las voces y los estilos disponibles en F0.
2. `voice.example.yml` + `lib/config.mjs` + tests de validación.
3. `lib/azure-tts.mjs` (SSML, escapado, REST, voices) + tests sin red: snapshot del SSML y
   escapado.
4. `lib/player.mjs` + `say` con caché + `lib/usage.mjs`.
5. `doctor` y `voices`.
6. `voice/skill/SKILL.md` + `install-skill`, regla en `_custom.md` y `config/local-paths.txt`.
7. Prueba real: `/career-ops interview/practice`, ronda de recruiter, 3 preguntas.

## 9. Criterios de aceptación

- `doctor` sale en verde con tu clave y tu región.
- En `interview/practice` la pregunta se oye sin pasos manuales.
- Cambiar `locale`, `voice`, `style`, `rate` o la persona en el YAML cambia la voz sin
  tocar código.
- Un estilo no admitido produce un aviso, no un error.
- Una pregunta con `<`, `&` o comillas se oye bien.
- La misma pregunta repetida sale de la caché y no suma caracteres.
- Ninguna clave aparece en logs ni en git.
- `node test-all.mjs` sigue pasando, porque el core no se toca.

## 10. Decisiones pendientes

- **Sistema operativo:** decide el reproductor por defecto. Con `player: auto` no es
  imprescindible.
- **Acento principal:** recomiendo `en-US`, porque la evaluación de prosodia del Plan 2
  parece existir solo en en-US (sin confirmar). Se pueden añadir otros acentos por persona.
- **Personas y tonos:** los del ejemplo son un punto de partida.
