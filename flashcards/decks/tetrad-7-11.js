/* Колода раздела «Карточки». Внутри addDeck( … ) — обычный JSON:
   id (латиницей, совпадает с именем файла), title и список слов.
   Прогресс ученика хранится по id, поэтому после публикации id лучше не
   менять — иначе прогресс по колоде начнётся заново.
   Слова — с двух страниц тетради (生词), переводы как записаны там,
   пиньинь сверен со словарём БКРС. */
addDeck({
  "id": "tetrad-7-11",
  "title": "Тетрадь · 7 ноября",
  "words": [
    { "hanzi": "时代", "pinyin": "shídài", "translation": "эпоха" },
    { "hanzi": "隐藏", "pinyin": "yǐncáng", "translation": "прятаться, скрываться" },
    { "hanzi": "巷子", "pinyin": "xiàngzi", "translation": "переулок" },
    { "hanzi": "盲目", "pinyin": "mángmù", "translation": "слепо, безрассудно" },
    { "hanzi": "追求", "pinyin": "zhuīqiú", "translation": "стремиться, гнаться за чем-то" },
    { "hanzi": "品味", "pinyin": "pǐnwèi", "translation": "вкус (эстетический)" },
    { "hanzi": "风气", "pinyin": "fēngqì", "translation": "общественные нравы, атмосфера" },
    { "hanzi": "平均", "pinyin": "píngjūn", "translation": "средний, поровну" },
    { "hanzi": "学问", "pinyin": "xuéwèn", "translation": "наука" },
    { "hanzi": "讲究", "pinyin": "jiǎngjiu", "translation": "требовательность, серьёзно относиться; разбираться, понимать толк; комфортабельный, со вкусом" },
    { "hanzi": "实践", "pinyin": "shíjiàn", "translation": "практика" },
    { "hanzi": "鲁迅", "pinyin": "Lǔ Xùn", "translation": "Лу Синь" },
    { "hanzi": "确保", "pinyin": "quèbǎo", "translation": "гарантировать" },
    { "hanzi": "准确性", "pinyin": "zhǔnquèxìng", "translation": "точность" },
    { "hanzi": "核对", "pinyin": "héduì", "translation": "сверять, проверять" },
    { "hanzi": "细节", "pinyin": "xìjié", "translation": "деталь" },
    { "hanzi": "古玩", "pinyin": "gǔwán", "translation": "антиквариат" },
    { "hanzi": "行家", "pinyin": "hángjiā", "translation": "мастер своего дела" },
    { "hanzi": "突如其来", "pinyin": "tūrúqílái", "translation": "внезапно, как снег на голову" },
    { "hanzi": "认可", "pinyin": "rènkě", "translation": "признание, одобрение" }
  ]
});
