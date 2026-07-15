# abn-effort-router

Enrutador de **effort** para Claude Code. Clasifica una tarea de código — o cada paso de un plan — por complejidad/acoplamiento y sugiere o aplica automáticamente el par **`(effort, modelo)`** óptimo, despachando el trabajo a un subagente del tier adecuado. Objetivo: **calidad > velocidad > coste**.

Caso de uso motor: migrar PHP legado (WordPress/Laravel/CLI) a Rust. El mecanismo es general.

## Cómo funciona

El `effort` del bucle principal de Claude Code no es programable por tarea. La palanca real es **despachar a subagentes**: un **Critic** barato (`claude-haiku-4-5`) clasifica la tarea; un **Actor** del tier recomendado (`sonnet-5` / `opus-4-8`, hasta `xhigh`) la ejecuta. Código entrelazado (score 5) dispara un **circuit breaker** y no se procesa.

Rúbrica score → `(effort, modelo)`:

| Score | effort | modelo |
|---|---|---|
| 1 | (omitido) | Haiku |
| 2 | medium | Sonnet 5 |
| 3 | medium | **Opus 4.8** (capable-first; alt: high · Sonnet 5) |
| 4 | high→xhigh | Opus 4.8 |
| 5 | — | **breaker** (`requires_human`) |

> **Capable-first:** para tareas complejas (score ≥ 3) se prefiere Opus 4.8 y se regula el coste con el **effort dentro de Opus**, no bajando de modelo. Haiku no acepta `output_config.effort` (se omite). `max` y Fable 5 solo con aprobación explícita.
>
> **Puerta de contexto:** Haiku tope 200K; Sonnet 5 / Opus 4.8 / Fable 5 son 1M (Opus 4.8 a precio estándar). Si el contexto es grande o `context_sensitivity=high` → excluir Haiku, preferir Opus 4.8 (1M). No hay un modelo "Opus 1M" separado: `claude-opus-4-8` ya es 1M.

## Estructura

```
.claude-plugin/
  plugin.json            manifest del plugin effort-router
  marketplace.json       catálogo (permite /plugin marketplace add)
skills/
  effort-router/
    SKILL.md             la skill (auto-descubierta por el plugin)
A-prompt/
  classifier.md          rúbrica + CLASSIFIER_SYSTEM_PROMPT + DECISION_SCHEMA + uso
  fixtures/              score{1,4,5}_*.php + *.expected.json (gold de validación)
PLAN.md                  plan completo (A→B→C)
```

## Uso

Guía completa end-to-end (instalación, escenarios tarea/plan, `--auto`/`--confirm`): **[USAGE.md](USAGE.md)**.

**Etapa A (validar la rúbrica):** clasificar los fixtures con Haiku y comparar contra los `*.expected.json`. Ver `A-prompt/classifier.md` §4-5.

**Etapa B (plugin):** instalar desde el repo público y ejecutar en Claude Code:
```
/plugin marketplace add <tu-usuario>/effort-router
/plugin install effort-router@effort-router-marketplace
/effort-router:effort-router [--auto|--confirm] <fichero|fragmento|plan>
```
- `--confirm` (default): muestra la decisión, aprobar antes de despachar.
- `--auto`: despacha directo al tier recomendado.

## Estado

- [x] Etapa A — activo reutilizable (rúbrica, prompt, schema, fixtures).
- [x] Etapa B — plugin `effort-router` (Critic Haiku → Actor tierizado, `--auto/--confirm`, tarea|plan, breaker).
- [ ] Etapa C — analizador de repo entero en **Rust** (concurrencia, caché por hash, guión de effort). Diferida hasta validar B.
