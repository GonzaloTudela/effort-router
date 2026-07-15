<?php
/**
 * Lógica pura: sin framework, sin I/O, sin estado global.
 * Entrada -> salida determinista. Score esperado: 1 (Haiku, sin effort).
 */
function slugify(string $text): string
{
    $text = strtolower(trim($text));
    $text = preg_replace('/[^a-z0-9]+/', '-', $text);
    return trim($text, '-');
}

function cents_to_eur(int $cents): string
{
    $eur = intdiv($cents, 100);
    $rem = abs($cents % 100);
    return sprintf('%d,%02d €', $eur, $rem);
}
