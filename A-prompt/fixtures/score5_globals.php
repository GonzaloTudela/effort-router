<?php
/**
 * Entrelazado profundo: global mutable + output buffering + orden implícito
 * de hooks con side-effects. Sin frontera. Score esperado: 5 (CIRCUIT BREAKER).
 */
function render_theme_shell(): void
{
    global $wp_query, $theme_state;

    // El orden en que se disparan estos hooks determina el HTML final,
    // y varios de ellos mutan $theme_state y escriben en el buffer.
    $theme_state['depth'] = ($theme_state['depth'] ?? 0) + 1;

    ob_start();
    do_action('theme_before_header');          // side-effects ocultos: enqueue, echo directo
    echo apply_filters('theme_header_html', ''); // filtros mutan estado global
    do_action('theme_after_header');

    if ($theme_state['depth'] > 1) {
        // reentrada: comportamiento depende del contador global
        do_action('theme_nested_shell');
    }

    $html = ob_get_clean();
    $GLOBALS['rendered_shell'] .= $html;        // acumulación en global
    $theme_state['depth']--;
}
