<?php
/**
 * Consulta compleja WP_Query con meta_query + caché por transient.
 * Estado tras frontera, pero async/ORM no trivial. Score esperado: 4 (xhigh, Opus).
 */
function featured_products_on_sale(int $limit = 12): array
{
    $cache_key = 'featured_on_sale_' . $limit;
    $cached = get_transient($cache_key);
    if ($cached !== false) {
        return $cached;
    }

    $query = new WP_Query([
        'post_type'      => 'product',
        'posts_per_page' => $limit,
        'meta_query'     => [
            'relation' => 'AND',
            ['key' => '_featured', 'value' => 'yes'],
            ['key' => '_sale_price', 'value' => 0, 'compare' => '>', 'type' => 'NUMERIC'],
        ],
        'orderby'        => 'meta_value_num',
        'meta_key'       => '_sale_price',
        'order'          => 'ASC',
    ]);

    $ids = wp_list_pluck($query->posts, 'ID');
    set_transient($cache_key, $ids, HOUR_IN_SECONDS);
    return $ids;
}
