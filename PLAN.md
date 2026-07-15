# abn-effort-router

Clasificador/enrutador de **effort** para Claude Code: analiza una tarea (o un plan multi-paso) y sugiere/aplica automáticamente el par **`(effort, modelo)`** con el que abordarla, para optimizar **calidad > velocidad > coste**. Enrutado por complejidad: barato abajo, caro arriba.

Caso de uso motor: desacoplar/migrar lógica PHP legada (WordPress/Laravel/CLI) a microservicios Rust concurrentes. El mecanismo es general.

---

## Hecho de viabilidad (cómo se controla el effort en Claude Code)

- El `effort`/modelo del **bucle principal NO es programable por tarea** — lo fija el usuario (`/model`, `/fast`, `/config`, `settings.json`).
- Los **hooks NO** pueden tocar parámetros de inferencia (solo permitir/denegar/inyectar contexto).
- El frontmatter de una **skill** puede sobreescribir `effort`/`model`, pero **estático y solo para el turno actual**.
- **Palanca dinámica por tarea = despachar el trabajo a subagentes** con su propio `model`+`effort`. Patrón canónico: **clasificar → despachar a subagente**.
- El **Workflow tool** `agent(prompt, {model, effort})` acepta `model` **y** `effort` (`low|medium|high|xhigh|max`) por llamada. Es el mecanismo programático limpio.

---

## Premisas de API (verificadas contra referencia `claude-api`)

- `budget_tokens` **eliminado** en Opus 4.8 / Sonnet 5 / Fable 5 → HTTP 400. Palanca vigente = `output_config.effort` + adaptive thinking.
- **`effort` NO existe en Haiku 4.5** (ni Sonnet 4.5) → error. El clasificador corre en Haiku, así que su llamada **omite `effort`**.
- **Structured outputs no soporta `minimum`/`maximum`** → `complexity_score` va como **enum**, no `int(1-5)`.
- Adaptive thinking: Opus 4.8 explícito (omitir = sin pensar); Sonnet 5/Fable 5 adaptive al omitir. Sin `temperature/top_p/top_k` (400). Streaming si `max_tokens > ~16K`. `output_config.format` (no `output_format`). Manejar `stop_reason == 'refusal'` antes de leer contenido.
- Modelos/precios: `claude-haiku-4-5` ($1/$5) · `claude-sonnet-5` ($3/$15) · `claude-opus-4-8` ($5/$25) · `claude-fable-5` ($10/$50).
- Fable 5 (extremos): thinking siempre ON (no enviar `disabled`, 400), requiere retención 30 días (ZDR → 400), refusal más probable → considerar `fallbacks` server-side.

En B el transporte lo gestiona Claude Code (Workflow/subagentes); `cache_control` y `task_budget` beta son detalles de C (API cruda).

---

## Roadmap A → B → C

| Etapa | Qué es | Construir | Objetivo |
|---|---|---|---|
| **A** | Prompt clasificador + rúbrica + schema | Minutos | Validar HOY que clasifica bien. Casi gratis. |
| **B** | Skill de Claude Code `/effort-router` | Horas | Clasifica **y** despacha a subagente al tier elegido. Interactiva. Sin infra. |
| **C** | Analizador de repo entero (Rust) | Días | Recorre el proyecto y emite un mapa de effort a nivel fichero/función/fragmento. |

**Regla de oro:** validar A antes de construir B; B antes de C.
**Rust:** solo en C (concurrencia, hashing, binario único). B es 1 llamada LLM por tarea → sin Rust.

---

## Activo reutilizable (Etapa A) — se escribe una vez, sirve en B y C

`A-prompt/classifier.md` contiene:

### 1. Rúbrica complejidad/acoplamiento 1-5 → `(effort, modelo)`

| Score | Definición | Señales | Decisión |
|---|---|---|---|
| **1** | Lógica pura, sin framework | funciones puras, matemática, transformación de strings | **Haiku** · **effort OMITIDO** (Haiku rechaza `effort`) |
| **2** | Deps triviales, fáciles de abstraer | `get_option()`, constantes, `wp_parse_args` | `medium` · Sonnet 5 |
| **3** | Estado moderado tras frontera clara | hooks/filters con firma clara, DB tras repositorio | `medium` · **Opus 4.8** (capable-first; alt: `high` · Sonnet 5) |
| **4** | Consultas/ORM complejos, async no trivial | `WP_Query` con `meta_query`, joins Eloquent, transients, caché | `high`→`xhigh` · Opus 4.8 |
| **5** | Entrelazado profundo, sin frontera | `global` mutable, output buffering, hooks con side-effects, orden implícito | **CIRCUIT BREAKER** — no despachar, `requires_human` |

**Capable-first:** score ≥ 3 → preferir Opus 4.8; regular coste con el **effort dentro de Opus**, no bajando de modelo. Techo `xhigh`; `max` y Fable 5 solo con aprobación. **Puerta de contexto:** Haiku tope 200K; Sonnet 5 / Opus 4.8 / Fable 5 = 1M (Opus 4.8 precio estándar). `context_sensitivity=high` o contexto >~180K → excluir Haiku, preferir Opus 4.8. (No hay "Opus 1M" separado; `claude-opus-4-8` ya es 1M.) **Solapamiento:** Sonnet 5 `high/xhigh` solapa con Opus 4.8 `low/medium` en tareas acotadas; Opus se despega en horizonte largo. Confirmar el punto de solape con barrido empírico.

### 2. `CLASSIFIER_SYSTEM_PROMPT`
Aísla lógica pura de deps framework, clasifica cada dep (trivial/port/entangled), puntúa 1-5, recomienda el par `(recommended_effort, recommended_model)`, sesgo conservador (ante duda → score mayor). Devuelve **solo** JSON.

### 3. `DECISION_SCHEMA` (json_schema estricto, `additionalProperties:false`)
```
complexity_score:   enum[1,2,3,4,5]          # NO int(min/max) — no soportado
summary:            string
dependencies:       [{name, kind:enum[framework|global|io|other], abstractability:enum[trivial|port|entangled]}]
pure_inputs:        [string]
pure_outputs:       [string]
invariants:         [string]
context_sensitivity: enum[low,high]                     # puerta de contexto: high -> excluir Haiku (200K), preferir Opus 4.8 (1M)
recommended_effort: enum[low,medium,high,xhigh]
recommended_model:  enum[claude-haiku-4-5,claude-sonnet-5,claude-opus-4-8,claude-fable-5]
requires_human:     bool
reasons:            [string]
```

---

## Etapa B — Plugin `effort-router`

**Layout:** plugin de Claude Code — `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` en la raíz; skill auto-descubierta en `skills/effort-router/SKILL.md`.
**Instalación:** `/plugin marketplace add <usuario>/effort-router` → `/plugin install effort-router@effort-router-marketplace`.
**Invocación:** `/effort-router:effort-router [--auto|--confirm] <fichero|fragmento|plan>`.

### Palanca de despacho (todo dentro de Claude Code, sin API key ni script)
- **Critic:** agente **Haiku** vía Workflow `agent(clasificaPrompt, {model:"haiku", schema: DECISION_SCHEMA})` — **sin `effort`**, sin thinking. Devuelve la decisión validada.
- **Actor:** subagente `agent(tareaPrompt, {model: decision.recommended_model, effort: decision.recommended_effort})`. **Si `model == claude-haiku-4-5` → OMITIR `effort`.**
- El Critic (Haiku) es más barato que el Actor: el control no cuesta lo mismo que el trabajo.

### Dos entradas
- **Tarea/fragmento** → par `(effort, modelo)`.
- **Plan multi-paso** → clasificar cada paso (Haiku en paralelo) → mapa `paso → (score, effort, modelo, requires_human)`; cada paso ejecuta en su tier.

### Dos modos
- `--confirm` (default): clasifica → muestra decisión/mapa → usuario aprueba/ajusta → despacha.
- `--auto`: clasifica → despacha directo (lotes/desatendido).

### Circuit breaker
`complexity_score == 5` → no despachar; marcar `requires_human`; proponer Anti-Corruption Layer / decisión humana.

### Flujo
```
entrada (tarea | plan)
  → Critic (Haiku, schema, sin effort)  → decisión(es) DECISION_SCHEMA
      score 5 → BREAKER (no despachar; requires_human)
      score≤4 → --confirm: mostrar (effort,modelo) → aprobar → despachar
                --auto:    agent({model, effort})   # omitir effort si model=haiku
  → (plan) mapa paso→(effort,modelo); fan-out de actores por paso
```

---

## Estructura del proyecto

```
effort-router/            ← repo público = plugin + marketplace
  .claude-plugin/
    plugin.json            ← manifest del plugin
    marketplace.json       ← catálogo (/plugin marketplace add)
  skills/
    effort-router/
      SKILL.md             ← skill auto-descubierta
  A-prompt/
    classifier.md          ← rúbrica + CLASSIFIER_SYSTEM_PROMPT + DECISION_SCHEMA + uso
    fixtures/              ← score1_pure.php, score4_wpquery.php, score5_globals.php (+ .expected.json)
  PLAN.md · README.md · USAGE.md · LICENSE
  (C-analyzer/            ← futuro, Rust)
```

---

## Verificación

- **A:** los 3 fixtures producen score/par esperado (1→Haiku sin effort, 4→xhigh/Opus, 5→breaker). Probar un 4º fragmento nuevo.
- **B:** invocar `/effort-router` sobre los fixtures → Critic usa `model:haiku`+`schema` **sin `effort`** (no 400); score 5 dispara breaker; `--confirm` muestra el par, `--auto` lanza el Actor; un plan emite el mapa `paso→(effort,modelo)`.

---

## Etapa C — diferida (Rust)

Analizador de repo entero: recorre → trocea `fichero→función→fragmento` → clasifica en lote (Haiku, **caché por hash**) → emite guión `{ruta, símbolo, score, effort, model, requires_human}`. Rust paga aquí: `tokio` (fan-out concurrente rate-limited) + `rayon` (hashing/parseo) + binario único para CI. El núcleo (rúbrica, prompts, schema, transporte, caché) se escribe una vez como lib Rust reutilizando el activo A. Detalles de API cruda: `cache_control` sobre el system prompt (mín. 4096 tokens en Haiku), `task_budget` beta (`task-budgets-2026-03-13`, mín 20K, no Haiku), SDK PHP camelCase o fallback cURL.

---

## Referencia

Skill `claude-api` (cacheada 2026-06): modelos/precios, `output_config.effort`, adaptive thinking, structured outputs, task-budgets beta, prompt caching. IDs exactos: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`.
