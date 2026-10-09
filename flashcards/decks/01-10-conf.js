/* Колода раздела «Карточки». Внутри addDeck( … ) — обычный JSON:
   id (латиницей, совпадает с именем файла), title и список слов.
   Прогресс ученика хранится по id, поэтому после публикации id лучше не
   менять — иначе прогресс по колоде начнётся заново. */
addDeck({
  "id": "01-10-conf",
  "title": "01.10-conf",
  "words": [
    { "hanzi": "丝绸之路", "pinyin": "Sīchóu zhī lù", "translation": "Шёлковый путь" },
    { "hanzi": "尽力", "pinyin": "jìnlì", "translation": "стараться изо всех сил" },
    { "hanzi": "反应", "pinyin": "fǎnyìng", "translation": "реакция" },
    { "hanzi": "石头", "pinyin": "shítou", "translation": "камень" },
    { "hanzi": "连续", "pinyin": "liánxù", "translation": "продолжать непрерывно" },
    { "hanzi": "碎", "pinyin": "suì", "translation": "разбить" },
    { "hanzi": "杆", "pinyin": "gǎn", "translation": "стержень, шест" },
    { "hanzi": "球杆", "pinyin": "qiúgǎn", "translation": "кий" },
    { "hanzi": "哎", "pinyin": "āi", "translation": "эй!, ой! (междометие удивления, недовольства; оклик) — не путать с 唉" },
    { "hanzi": "唉", "pinyin": "āi", "translation": "эх! (вздох сожаления, досады) — не путать с 哎" },
    { "hanzi": "几乎", "pinyin": "jīhū", "translation": "почти (= 差不多)" },
    { "hanzi": "债务", "pinyin": "zhàiwù", "translation": "долг" },
    { "hanzi": "冠军", "pinyin": "guànjūn", "translation": "чемпион, 1-е место" },
    { "hanzi": "亚军", "pinyin": "yàjūn", "translation": "2-е место" },
    { "hanzi": "季军", "pinyin": "jìjūn", "translation": "3-е место" },
    { "hanzi": "金属", "pinyin": "jīnshǔ", "translation": "металл" },
    { "hanzi": "铜钱", "pinyin": "tóngqián", "translation": "медная монета" },
    { "hanzi": "硬", "pinyin": "yìng", "translation": "твёрдый" },
    { "hanzi": "软", "pinyin": "ruǎn", "translation": "мягкий" },
    { "hanzi": "肌肉", "pinyin": "jīròu", "translation": "мышцы, мускулы" },
    { "hanzi": "便", "pinyin": "biàn", "translation": "тогда, сразу (= 就, письменный стиль 书面)" },
    { "hanzi": "打动", "pinyin": "dǎdòng", "translation": "тронуть, растрогать (= 感动)" },
    { "hanzi": "诚心", "pinyin": "chéngxīn", "translation": "искренность" },
    { "hanzi": "专心", "pinyin": "zhuānxīn", "translation": "настойчивость, увлечённость" },
    { "hanzi": "精诚所至，金石为开", "pinyin": "jīngchéng suǒ zhì, jīnshí wèi kāi", "translation": "Абсолютная искренность может повлиять даже на металл и камень (нет непреодолимых трудностей)" }
  ]
});
