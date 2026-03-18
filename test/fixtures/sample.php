<?php

interface Cacheable {
    public function getCacheKey(): string;
    public function getTtl(): int;
}

trait Timestamps {
    public function getCreatedAt(): string {
        return $this->createdAt;
    }

    public function touch(): void {
        $this->updatedAt = date('Y-m-d H:i:s');
    }
}

class Article implements Cacheable {
    use Timestamps;

    private string $title;
    private string $body;
    private string $createdAt;
    private string $updatedAt;

    public function __construct(string $title, string $body) {
        $this->title = $title;
        $this->body = $body;
        $this->createdAt = date('Y-m-d H:i:s');
        $this->updatedAt = $this->createdAt;
    }

    public function getCacheKey(): string {
        return 'article_' . md5($this->title);
    }

    public function getTtl(): int {
        return 3600;
    }
}

function slugify(string $text): string {
    return strtolower(preg_replace('/[^a-z0-9]+/i', '-', trim($text)));
}
