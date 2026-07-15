# Etapa A — Clasificador de effort

Activo reutilizable por B (skill) y C (analizador Rust). Se escribe una vez.
Contiene: **rúbrica**, **`CLASSIFIER_SYSTEM_PROMPT`**, **`DECISION_SCHEMA`** (json_schema real) e **instrucciones de uso**.

---

## 1. Rúbrica de complejidad/acoplamiento 1-5 → `(effort, modelo)`

| Score | Definición | Señales típicas (PHP/WP/Laravel) | Decisión |
|---|---|---|---|
| **1** | Lógica pura, sin framework | funciones puras, matemática, transformación de strings, sin I/O ni globals | **`claude-haiku-4-5`** · **effort OMITIDO** (Haiku rechaza `output_config.effort`) |
| **2** | Deps triviales, fáciles de abstraer | `get_option()`, constantes, `wp_parse_args`, helpers simples | **`medium`** · `claude-sonnet-5` |
| **3** | Estado moderado tras frontera clara | hooks/filters con firma clara, DB tras repositorio, servicios inyectados | **`medium`** · **`claude-opus-4-8`** (capable-first; alt. coste-crítico: `high` · Sonnet 5) |
| **4** | Consultas/ORM complejos, async no trivial | `WP_Query` con `meta_query`, joins Eloquent, transients, caché, side-effects acotados | **`high`→`xhigh`** · **`claude-opus-4-8`** |
| **5** | Entrelazado profundo, sin frontera | `global` mutable, output buffering, hooks con side-effects ocultos, orden de ejecución implícito | **CIRCUIT BREAKER** — no despachar, `requires_human = true` |

**Reglas:**
- **Capable-first:** para tareas complejas (score ≥ 3) preferir el modelo más capaz (**Opus 4.8**) y usar el **effort como palanca de coste DENTRO de Opus** (`medium`→`high`→`xhigh`), en vez de bajar a Sonnet. Solo bajar de modelo para trabajo claramente ligero (score 1-2).
- **Puerta de contexto:** Haiku tope **200K**; Sonnet 5 / Opus 4.8 / Fable 5 son **1M** (Opus 4.8 a precio estándar, sin premium). Si `context_sensitivity == "high"` o el contexto supera ~180K tokens → **excluir Haiku**, preferir Opus 4.8 (1M). *(No existe un modelo "Opus 1M" separado: `claude-opus-4-8` ya es 1M.)*
- Techo del clasificador: `xhigh`. **`max` y `claude-fable-5` NUNCA** los recomienda el modelo; requieren aprobación humana explícita.
- **Sesgo conservador:** ante duda, subir el score. Un "seguro" falso produce una traducción insegura; un "entangled" falso solo cuesta una revisión humana.
- El modelo **diagnostica** (score + par recomendado + `context_sensitivity`); el código/usuario **decide** si despacha.
- **Haiku no acepta `effort`.** Cuando `recommended_model == "claude-haiku-4-5"`, `recommended_effort` es solo documental — el dispatcher lo omite en la llamada.

### Solapamiento Opus/Sonnet por effort (razonado desde la referencia `claude-api`; pendiente de confirmar empíricamente)

- Sonnet 5 en `high`/`xhigh` **solapa** con Opus 4.8 en `low`/`medium` en muchas tareas complejas-pero-acotadas, a ~60% del coste ($3/$15 vs $5/$25).
- Opus 4.8 se despega en `high`/`xhigh` en trabajo **de horizonte largo** y en corrección/verificación de bugs.
- Efecto no monótono: subir effort no siempre mejora; en Opus 4.8 conviene **partir de `high` y barrer**, reservar `max` para lo más duro (con aprobación).
- **Política elegida (preferencia al capaz):** en la zona de solapamiento, **preferir Opus** y regular coste bajando su effort, no cambiando de modelo. Confirmar el punto exacto de solape con un barrido empírico (ver PLAN §Verificación).

---

## 2. `CLASSIFIER_SYSTEM_PROMPT`

> Pegar como `system` de la llamada clasificadora (Haiku). No incluye `effort` ni `thinking`.

```text
Eres un clasificador de complejidad de código para un enrutador de effort que migra PHP legado (WordPress/Laravel/CLI) a Rust. Recibes UN fragmento de código (función, método o bloque suelto) y devuelves SOLO un objeto JSON conforme al schema, sin texto adicional.

Tu tarea:
1. Aísla la LÓGICA PURA (entradas → salidas deterministas, sin efectos) de las DEPENDENCIAS de framework/entorno.
2. Clasifica cada dependencia por su facilidad de portar:
   - "trivial": constante, opción de config, helper puro, valor inyectable sin lógica.
   - "port": tiene equivalente Rust claro tras una frontera (repositorio, servicio, cliente), aunque requiera trabajo.
   - "entangled": estado global mutable, orden de ejecución implícito, side-effects ocultos, output buffering, o acoplamiento que NO tiene equivalente Rust seguro sin rediseño.
3. Puntúa la complejidad/acoplamiento de 1 a 5 según la rúbrica:
   1 = lógica pura sin framework.
   2 = dependencias triviales, fáciles de abstraer.
   3 = estado moderado tras una frontera clara.
   4 = consultas/ORM complejos o async no trivial (deps difíciles pero PORTABLES tras una frontera: repositorio, servicio, cliente).
   5 = entrelazado profundo SIN frontera: global mutable con orden de ejecución implícito, output buffering, o side-effects ocultos sin equivalente Rust seguro. Una dependencia "entangled" que vive TRAS una frontera clara (p. ej. WP_Query tras un repositorio) NO es score 5 — es 3 o 4 y SÍ se despacha.
4. Estima context_sensitivity ("low" | "high"): "high" si migrar el fragmento de forma segura exige contexto amplio (muchos ficheros, esquema de DB, invariantes cruzadas entre unidades).
5. Recomienda el par (recommended_effort, recommended_model) con PREFERENCIA AL MODELO MÁS CAPAZ (Opus). El effort es la palanca de coste DENTRO de Opus; no bajes de modelo salvo trabajo claramente ligero:
   score 1 -> ("low", "claude-haiku-4-5")    [effort documental; Haiku no lo usa. Si context_sensitivity="high" -> ("low","claude-sonnet-5")]
   score 2 -> ("medium", "claude-sonnet-5")
   score 3 -> ("medium", "claude-opus-4-8")  [alternativa coste-crítico: ("high","claude-sonnet-5")]
   score 4 -> ("high", "claude-opus-4-8")     [sube a "xhigh" si el paso es largo / horizonte largo]
   score 5 -> requires_human = true (no se despacha)
6. Contexto: si context_sensitivity="high", NUNCA recomiendes "claude-haiku-4-5" (tope 200K); usa un modelo 1M (Opus 4.8 preferido, precio estándar).
7. Techo: nunca recomiendes "max" ni "claude-fable-5". Techo de effort = "xhigh".
8. Sesgo conservador: ante duda entre dos scores, elige el MAYOR. `requires_human = true` SI Y SOLO SI `complexity_score == 5`. NO marques requires_human por la mera presencia de una dep "entangled": solo el entrelazado SIN frontera (global mutable con orden implícito, output buffering con side-effects ocultos) es score 5 / breaker. Una dep difícil pero portable tras una frontera se despacha con effort alto (score 3-4), no se bloquea.

En "reasons" da 1-3 frases concretas justificando el score (qué dependencia lo eleva, qué invariante peligra). En "invariants" lista propiedades que la traducción a Rust debe preservar (p. ej. "el orden de los hooks determina el HTML final", "el contador global no puede reiniciarse entre llamadas").

Devuelve ÚNICAMENTE el JSON.
```

---

## 3. `DECISION_SCHEMA` (para `output_config.format`)

> `type: "json_schema"`. `additionalProperties:false` y `required` con TODAS las claves en cada objeto (requisito estricto). `complexity_score` es `enum` de enteros — structured outputs NO valida `minimum`/`maximum`.

```json
{
  "type": "json_schema",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "complexity_score",
      "summary",
      "dependencies",
      "pure_inputs",
      "pure_outputs",
      "invariants",
      "context_sensitivity",
      "recommended_effort",
      "recommended_model",
      "requires_human",
      "reasons"
    ],
    "properties": {
      "complexity_score": { "type": "integer", "enum": [1, 2, 3, 4, 5] },
      "summary": { "type": "string" },
      "dependencies": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["name", "kind", "abstractability"],
          "properties": {
            "name": { "type": "string" },
            "kind": { "type": "string", "enum": ["framework", "global", "io", "other"] },
            "abstractability": { "type": "string", "enum": ["trivial", "port", "entangled"] }
          }
        }
      },
      "pure_inputs": { "type": "array", "items": { "type": "string" } },
      "pure_outputs": { "type": "array", "items": { "type": "string" } },
      "invariants": { "type": "array", "items": { "type": "string" } },
      "context_sensitivity": { "type": "string", "enum": ["low", "high"] },
      "recommended_effort": { "type": "string", "enum": ["low", "medium", "high", "xhigh"] },
      "recommended_model": {
        "type": "string",
        "enum": ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"]
      },
      "requires_human": { "type": "boolean" },
      "reasons": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

---

## 4. Uso

### Dentro de Claude Code (Etapa B, sin API key)
La skill despacha un agente Haiku vía Workflow:
```
agent(CLASSIFIER_SYSTEM_PROMPT + "\n\nFRAGMENTO:\n" + codigo,
      { model: "haiku", schema: DECISION_SCHEMA_SOLO_SCHEMA })   // sin effort, sin thinking
```
> En Workflow `agent(prompt, {schema})` se pasa el **objeto `schema` interior** (el valor de la clave `"schema"` de arriba), no el envoltorio `{type:"json_schema", ...}`.

### API cruda (Etapa C, referencia)
```jsonc
POST /v1/messages
{
  "model": "claude-haiku-4-5",
  "max_tokens": 2048,
  "system": [{ "type": "text", "text": "<CLASSIFIER_SYSTEM_PROMPT>", "cache_control": {"type":"ephemeral"} }],
  "output_config": { "format": { /* DECISION_SCHEMA completo */ } },
  // NADA de output_config.effort  -> Haiku daría 400
  // NADA de thinking
  "messages": [{ "role": "user", "content": "FRAGMENTO:\n<codigo>" }]
}
```
Manejar `stop_reason == "refusal"` antes de leer `content`. En Haiku el mínimo cacheable son 4096 tokens: si el system prompt es más corto, `cache_control` no cachea (silencioso).

### Aplicar la decisión
- `requires_human == true` (o `complexity_score == 5`) → **no despachar**; proponer Anti-Corruption Layer / revisión humana.
- Si no → despachar el trabajo real al Actor con `(recommended_effort, recommended_model)`; **omitir `effort` si el modelo es `claude-haiku-4-5`**.

---

## 5. Validación (fixtures)

`fixtures/` contiene 3 fragmentos PHP y su JSON esperado:
- `score1_pure.php` → `complexity_score: 1`, `claude-haiku-4-5`, `requires_human: false`.
- `score4_wpquery.php` → frontera 3/4 (WP_Query es `port` tras frontera); `complexity_score ∈ {3,4}`, **ambos → `claude-opus-4-8`** (medium/high), `requires_human: false`. Capable-first hace el enrutado robusto al ruido 3↔4.
- `score5_globals.php` → `complexity_score: 5`, `requires_human: true` (breaker).

Criterio de aceptación: los 3 producen el score/tier esperado. Probar además un 4º fragmento nuevo y juzgar a mano la clasificación.
