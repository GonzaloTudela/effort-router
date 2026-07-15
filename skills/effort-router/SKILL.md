---
name: effort-router
description: Clasifica una tarea de código (o cada paso de un plan) por complejidad/acoplamiento y sugiere o aplica el par (effort, modelo) óptimo despachando el trabajo a un subagente del tier adecuado. Úsala cuando el usuario invoque /effort-router, pida "enrutar por effort", "elegir modelo y effort para esta tarea/plan", o quiera optimizar calidad>velocidad>coste en una migración PHP→Rust u otra tarea. NO fija el effort del bucle principal (imposible); enruta a subagentes.
---

# effort-router

Enruta trabajo por complejidad: barato abajo, caro arriba. Un **Critic** barato (Haiku) clasifica; un **Actor** del tier recomendado ejecuta. El bucle principal no cambia su effort — la palanca vive en el **despacho a subagente**.

## Invocación

Como plugin, el comando lleva el namespace del plugin:
```
/effort-router:effort-router [--auto|--confirm] <fichero | fragmento pegado | plan multi-paso>
```
La skill también se activa por relevancia (sin barra) cuando el usuario pide "enrutar por effort", "elegir modelo y effort para esta tarea/plan", etc.

- `--confirm` (por defecto): clasifica → muestra la decisión → el usuario aprueba/ajusta → despacha.
- `--auto`: clasifica → despacha directo (lotes / desatendido).

## Procedimiento

### 1. Determina el tipo de entrada
- **Tarea/fragmento suelto** → una clasificación.
- **Plan multi-paso** (lista numerada de pasos, o el usuario dice "plan") → clasificar **cada paso** por separado.

### 2. Clasifica con el Critic (Haiku) vía Workflow — SIN `effort`
Llama al **Workflow tool** (esta skill te autoriza a usarlo) con el script de más abajo. La clasificación usa `model: "haiku"` con `schema` forzado y **NO** pasa `effort` (Haiku lo rechaza → 400) ni `thinking`.

El agente clasificador recibe este system prompt seguido del fragmento:

```
Eres un clasificador de complejidad de código para un enrutador de effort que migra PHP legado (WordPress/Laravel/CLI) a Rust. Recibes UN fragmento y devuelves SOLO el objeto JSON del schema.
1. Aísla la lógica pura de las dependencias de framework/entorno; clasifica cada dep: "trivial" | "port" | "entangled".
2. Puntúa complexity_score 1-5: 1=lógica pura; 2=deps triviales; 3=estado moderado tras frontera clara; 4=ORM/consultas complejas o async no trivial (deps difíciles pero PORTABLES tras una frontera); 5=entrelazado profundo SIN frontera (global mutable con orden implícito, output buffering con side-effects ocultos). Una dep "entangled" tras una frontera clara NO es 5.
3. Estima context_sensitivity ("low"|"high"): "high" si migrar de forma segura exige contexto amplio (muchos ficheros, esquema, invariantes cruzadas).
4. Recomienda el par (recommended_effort, recommended_model) con PREFERENCIA AL MODELO MÁS CAPAZ (Opus); el effort es la palanca de coste DENTRO de Opus, no bajes de modelo salvo trabajo claramente ligero:
   1 -> ("low","claude-haiku-4-5")    [si context_sensitivity="high" -> ("low","claude-sonnet-5")]
   2 -> ("medium","claude-sonnet-5")
   3 -> ("medium","claude-opus-4-8")  [alternativa coste-crítico: ("high","claude-sonnet-5")]
   4 -> ("high","claude-opus-4-8")    [sube a "xhigh" si el paso es largo/horizonte largo]
   5 -> requires_human=true (breaker; no despachar)
5. Contexto: si context_sensitivity="high", NUNCA recomiendes "claude-haiku-4-5" (tope 200K); usa un modelo 1M (Opus 4.8 preferido).
6. Techo: nunca recomiendes "max" ni "claude-fable-5" (requieren aprobación humana explícita).
7. requires_human = true SI Y SOLO SI complexity_score == 5. NO lo marques por una dep "entangled" que vive tras una frontera clara.
Devuelve ÚNICAMENTE el JSON.
```

### 3. Circuit breaker
Si `complexity_score == 5` o `requires_human == true`: **no despaches**. Informa al usuario, resume por qué (usa `reasons` e `invariants`) y propón una Anti-Corruption Layer o revisión humana. Nunca fuerces la traducción de código entrelazado.

### 4. Despacha el Actor
Para cada unidad con `score ≤ 4` y `requires_human == false`:
- **`--confirm`**: muestra `score`, `recommended_effort`, `recommended_model`, `summary` y `reasons`. Para un plan, muestra la tabla `paso → (effort, modelo)`. Espera aprobación (o ajuste) antes de despachar.
- **`--auto`**: despacha directo.

Despacho vía Workflow `agent(tareaPrompt, { model, effort })`. **Si `recommended_model == "claude-haiku-4-5"` → OMITE `effort`** (Haiku lo rechaza).

**Puerta de contexto (capable-first):** antes de despachar, si `context_sensitivity == "high"` **o** el target/su contexto requerido supera ~180K tokens, **excluye Haiku** (tope 200K) y usa un modelo 1M — **prefiere `claude-opus-4-8`** (1M nativo, precio estándar). Ante empate de calidad entre Opus a effort bajo y Sonnet a effort alto, **prefiere Opus** (modelo más capaz); baja el effort de Opus antes que bajar de modelo.

Nunca despaches a `max` ni `claude-fable-5` sin que el usuario lo apruebe explícitamente.

## Script de Workflow (rellena TARGET / PASOS)

Para una **tarea suelta**:

```js
export const meta = {
  name: 'effort-router-single',
  description: 'Clasifica una tarea y (opcional) la ejecuta en el tier recomendado',
  phases: [{ title: 'Clasificar' }, { title: 'Ejecutar' }],
}

const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['complexity_score','summary','dependencies','pure_inputs','pure_outputs','invariants','context_sensitivity','recommended_effort','recommended_model','requires_human','reasons'],
  properties: {
    complexity_score: { type: 'integer', enum: [1,2,3,4,5] },
    summary: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name','kind','abstractability'],
      properties: { name: {type:'string'}, kind: {type:'string', enum:['framework','global','io','other']}, abstractability: {type:'string', enum:['trivial','port','entangled']} } } },
    pure_inputs: { type: 'array', items: { type: 'string' } },
    pure_outputs: { type: 'array', items: { type: 'string' } },
    invariants: { type: 'array', items: { type: 'string' } },
    context_sensitivity: { type: 'string', enum: ['low','high'] },
    recommended_effort: { type: 'string', enum: ['low','medium','high','xhigh'] },
    recommended_model: { type: 'string', enum: ['claude-haiku-4-5','claude-sonnet-5','claude-opus-4-8','claude-fable-5'] },
    requires_human: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
}
const CLASSIFIER = `${/* pega aquí el system prompt del paso 2 */ ''}`
const TARGET = args?.target ?? ''       // código a clasificar
const AUTO   = args?.auto === true      // false = --confirm

phase('Clasificar')
// Critic Haiku: sin effort, schema forzado
const d = await agent(`${CLASSIFIER}\n\nFRAGMENTO:\n${TARGET}`,
                      { label: 'critic', model: 'haiku', schema: DECISION_SCHEMA })

if (d.requires_human || d.complexity_score === 5) {
  return { breaker: true, decision: d }   // no despachar
}
if (!AUTO) {
  return { decision: d }                  // --confirm: devolver para que el main loop lo muestre y pida aprobación
}

phase('Ejecutar')
const opts = { label: `actor:${d.recommended_model}`, model: d.recommended_model }
if (d.recommended_model !== 'claude-haiku-4-5') opts.effort = d.recommended_effort  // Haiku no acepta effort
const result = await agent(`Realiza la tarea:\n${TARGET}`, opts)
return { decision: d, result }
```

Para un **plan multi-paso**: clasifica los pasos en paralelo y (en `--auto`) despáchalos en pipeline:

```js
const PASOS = args?.steps ?? []   // [{id, text}, ...]
phase('Clasificar')
const decisiones = await parallel(PASOS.map(p => () =>
  agent(`${CLASSIFIER}\n\nPASO ${p.id}:\n${p.text}`, { label: `critic:${p.id}`, model: 'haiku', schema: DECISION_SCHEMA })
    .then(d => ({ id: p.id, text: p.text, d }))
))
const mapa = decisiones.filter(Boolean).map(({id, text, d}) => ({ id, score: d.complexity_score, effort: d.recommended_effort, model: d.recommended_model, requires_human: d.requires_human || d.complexity_score === 5 }))
if (!AUTO) return { mapa }   // --confirm: mostrar tabla y pedir aprobación
phase('Ejecutar')
const results = await parallel(decisiones.filter(Boolean).map(({id, text, d}) => () => {
  if (d.requires_human || d.complexity_score === 5) return Promise.resolve({ id, breaker: true, d })
  const opts = { label: `actor:${id}:${d.recommended_model}`, phase: 'Ejecutar', model: d.recommended_model }
  if (d.recommended_model !== 'claude-haiku-4-5') opts.effort = d.recommended_effort
  return agent(`Realiza el paso ${id}:\n${text}`, opts).then(r => ({ id, d, result: r }))
}))
return { mapa, results }
```

## Guardarraíles

- **Haiku nunca lleva `effort`** (ni el Critic ni un Actor Haiku).
- **`max` y `claude-fable-5`** solo con aprobación explícita del usuario.
- **Score 5 / `requires_human`** → breaker, nunca despachar.
- El clasificador es el activo de `A-prompt/classifier.md` (fuente canónica de rúbrica, prompt y schema). Mantén este archivo en sincronía con él.

## Instalación (plugin de Claude Code)

Esta skill es parte del plugin `effort-router`, auto-descubierta en `skills/effort-router/SKILL.md`. Instalar desde el repo público:

```
/plugin marketplace add GonzaloTudela/effort-router
/plugin install effort-router@effort-router-marketplace
```

Desarrollo local (sin publicar), desde la raíz del repo:
```
/plugin marketplace add ./
/plugin install effort-router@effort-router-marketplace
```
Tras instalar, invoca `/effort-router:effort-router` (o deja que se active por relevancia).
