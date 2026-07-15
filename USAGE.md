# Uso de abn-effort-router

Guía end-to-end de las tres etapas. Hoy usable: **A** (validar la rúbrica) y **B** (la skill). **C** (Rust) está diferida.

---

## Modelo mental

No se ajusta el `effort` del turno principal (Claude Code no lo permite por tarea). En su lugar:

```
tu tarea/plan
   │
   ▼
 Critic  (claude-haiku-4-5, barato, JSON forzado, SIN effort)
   │   clasifica: score 1-5 + (effort, modelo) + context_sensitivity
   ▼
 ¿score 5 / requires_human?  ── sí ──▶  BREAKER: no despachar, proponer ACL / revisión humana
   │ no
   ▼
 Actor  (subagente al tier recomendado; capable-first → Opus para score ≥ 3)
   │   effort = palanca de coste DENTRO de Opus; Haiku sin effort; contexto grande → excluir Haiku
   ▼
 resultado
```

---

## Etapa A — validar la rúbrica (sin instalar nada)

Objetivo: comprobar que el clasificador acierta antes de construir sobre él.

1. Abre `A-prompt/classifier.md` (rúbrica, `CLASSIFIER_SYSTEM_PROMPT`, `DECISION_SCHEMA`).
2. Clasifica los fixtures con Haiku y compara contra el gold:

   | Fixture | Esperado |
   |---|---|
   | `fixtures/score1_pure.php` | score 1 · Haiku · `requires_human:false` |
   | `fixtures/score4_wpquery.php` | score 3-4 (frontera) · **Opus 4.8** · `requires_human:false` |
   | `fixtures/score5_globals.php` | score 5 · **breaker** (`requires_human:true`) |

3. Forma rápida dentro de Claude Code (una clasificación suelta):
   > "Clasifica `A-prompt/fixtures/score4_wpquery.php` con el CLASSIFIER_SYSTEM_PROMPT de `A-prompt/classifier.md` usando un subagente Haiku, devuelve el JSON del DECISION_SCHEMA."

4. Criterio de aceptación: los 3 producen el tier esperado (1→Haiku, 3/4→Opus, 5→breaker). Probar un 4º fragmento nuevo y juzgar a mano.

> Nota: la llamada Haiku va **sin** `output_config.effort` (Haiku lo rechaza → 400) y **sin** `thinking`; solo `output_config.format` con el schema.

---

## Etapa B — la skill `/effort-router`

### Instalar

```bash
# desde la raíz del repo
mkdir -p ~/.claude/skills/effort-router
cp B-skill/SKILL.md ~/.claude/skills/effort-router/SKILL.md
```
Reinicia/relee skills en Claude Code. (En Windows con PowerShell: `New-Item -ItemType Directory -Force ~/.claude/skills/effort-router; Copy-Item B-skill/SKILL.md ~/.claude/skills/effort-router/SKILL.md`.)

### Invocar

```
/effort-router [--auto|--confirm] <fichero | fragmento pegado | plan>
```

### Escenario 1 — una tarea, con confirmación (default)

```
/effort-router src/Legacy/PriceCalculator.php
```
La skill:
1. Lanza el **Critic** Haiku → decisión `DECISION_SCHEMA`.
2. Muestra: `score`, `(effort, modelo)`, `context_sensitivity`, `summary`, `reasons`.
3. Espera tu OK (o ajuste) y **despacha** el Actor al tier recomendado.

Ejemplo de decisión mostrada:
```
score 3 · claude-opus-4-8 · effort=medium · context_sensitivity=high
resumen: repositorio tras frontera + caché; portable.
→ ¿Despachar a Opus 4.8 (medium)?  [sí / ajustar / no]
```

### Escenario 2 — desatendido (lotes)

```
/effort-router --auto src/Legacy/PriceCalculator.php
```
Clasifica y **despacha directo** al tier recomendado, sin pausa. Ideal para procesar muchas unidades.

### Escenario 3 — un plan multi-paso

```
/effort-router --confirm "Plan:
1. Extraer slugify() a un módulo puro
2. Migrar featured_products_on_sale() con repositorio + caché
3. Desacoplar render_theme_shell() (globals + output buffering)"
```
La skill clasifica **cada paso en paralelo** (Critic Haiku) y emite el mapa:

| Paso | score | effort | modelo | requires_human |
|---|---|---|---|---|
| 1 | 1 | (omitido) | Haiku | no |
| 2 | 3-4 | medium/high | Opus 4.8 | no |
| 3 | 5 | — | — | **sí (breaker)** |

En `--auto`, despacha los pasos 1-2 a su tier y **marca el 3 para revisión humana** (Anti-Corruption Layer), sin intentar traducirlo.

### Reglas que aplica la skill

- **Capable-first:** score ≥ 3 → Opus 4.8; el coste se regula con el effort de Opus, no bajando de modelo.
- **Haiku sin `effort`** (Critic y cualquier Actor Haiku).
- **Puerta de contexto:** `context_sensitivity=high` o contexto >~180K → excluir Haiku (tope 200K), preferir Opus 4.8 (1M nativo).
- **Breaker:** score 5 / `requires_human` → nunca despachar.
- **`max` y Fable 5** solo con tu aprobación explícita.

---

## Etapa C — analizador de repo (futuro, Rust)

Cuando B esté validado: `C-analyzer/` recorrerá un proyecto entero, troceará a `fichero→función→fragmento`, clasificará en lote (Haiku, caché por hash) y emitirá un guión:

```json
[{ "ruta": "src/Legacy/Price.php", "simbolo": "featured_products_on_sale",
   "complexity_score": 4, "effort": "high", "model": "claude-opus-4-8",
   "context_sensitivity": "high", "requires_human": false }]
```
Ese guión conduce la migración desatendida, aplicando a cada unidad su tier con breaker y `max_iterations`. Rust por concurrencia (`tokio`), hashing/parseo (`rayon`) y binario único para CI.

---

## Referencia rápida de modelos

| Modelo | Contexto | $/1M (in/out) | Uso en el router |
|---|---|---|---|
| `claude-haiku-4-5` | 200K | 1 / 5 | Critic; Actor score 1 (sin effort) |
| `claude-sonnet-5` | 1M | 3 / 15 | Actor score 2; alternativa coste-crítico |
| `claude-opus-4-8` | 1M | 5 / 25 | Actor score 3-4 (capable-first) |
| `claude-fable-5` | 1M | 10 / 50 | solo con aprobación explícita |
