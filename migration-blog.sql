-- migration-blog.sql
-- Blog posts table for RealtorFinder market insights
-- Run after migration-cities.sql

CREATE TABLE IF NOT EXISTS blog_posts (
    id               SERIAL PRIMARY KEY,
    slug             VARCHAR(200) UNIQUE NOT NULL,
    title            VARCHAR(300) NOT NULL,
    excerpt          TEXT,
    content          TEXT,
    author           VARCHAR(100) DEFAULT 'RealtorFinder Team',
    category         VARCHAR(100),
    state_code       CHAR(2),
    city_slug        VARCHAR(100),
    published_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    is_published     BOOLEAN DEFAULT TRUE,
    read_time_minutes INTEGER DEFAULT 5
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug        ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published   ON blog_posts(is_published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_state       ON blog_posts(state_code) WHERE state_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blog_posts_category    ON blog_posts(category);
