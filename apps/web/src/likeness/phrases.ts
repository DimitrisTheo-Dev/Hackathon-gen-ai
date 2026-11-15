/**
 * What the person reads aloud in the speech step: two random phrases and the consent statement with their
 * name, about 30 seconds in all. The random phrases work like a one-time spoken passphrase: a prepared video
 * cannot know them, so reading them proves the recording is live (they also cover many mouth shapes for
 * lip sync). The statement is the spoken permission the engine keeps with the consent. Pure.
 */
import { likenessConsentStatement, type LikenessLanguage } from "@castroom/contracts";

export { likenessConsentStatement as consentStatement, type LikenessLanguage };

// Phonetically varied sentences: rounded vowels, lip closures (p, b, m), teeth on lip (f, v), wide smiles.
const PHRASES: Record<LikenessLanguage, string[]> = {
  en: [
    "The quick brown fox jumps over the lazy dog while the people watch from the bridge.",
    "Bright morning sunshine warms the blue ocean and the boats move slowly toward the harbour.",
    "My favourite meal is fresh bread with olive oil, tomatoes and a cup of warm coffee.",
    "We usually meet at seven, choose a quiet place and talk about music, movies and books.",
    "Please remember to bring the map, the umbrella and five bottles of water for the trip.",
    "Every Friday evening my family cooks pasta, plays board games and laughs until midnight.",
    "Big yellow balloons floated above the village square while children were singing happily.",
    "Thank you for waiting, the whole team will be ready in a few minutes with good news.",
    "Few things feel better than a long walk by the sea when the wind is cool and soft.",
    "Our new office is on the fourth floor, right next to the bakery with the purple door.",
  ],
  el: [
    "Το πρωί ο ήλιος φωτίζει τη θάλασσα και οι βάρκες φεύγουν αργά από το λιμάνι.",
    "Μου αρέσει το φρέσκο ψωμί με λάδι, ντομάτα και ένα ζεστό φλιτζάνι καφέ.",
    "Κάθε Παρασκευή βράδυ η οικογένεια μαγειρεύει μακαρόνια και παίζει επιτραπέζια παιχνίδια.",
    "Θυμήσου να πάρεις τον χάρτη, την ομπρέλα και πέντε μπουκάλια νερό για το ταξίδι.",
    "Συναντιόμαστε συνήθως στις επτά και μιλάμε για μουσική, ταινίες και βιβλία.",
    "Μεγάλα κίτρινα μπαλόνια πετούσαν πάνω από την πλατεία ενώ τα παιδιά τραγουδούσαν.",
    "Ευχαριστώ που περιμένατε, η ομάδα θα είναι έτοιμη σε λίγα λεπτά με καλά νέα.",
    "Λίγα πράγματα είναι καλύτερα από έναν μεγάλο περίπατο δίπλα στη θάλασσα.",
    "Το νέο μας γραφείο είναι στον τέταρτο όροφο, δίπλα στον φούρνο με τη μωβ πόρτα.",
    "Το φθινόπωρο τα φύλλα πέφτουν και ο αέρας μυρίζει βροχή και ζεστά κάστανα.",
  ],
};

/** Two different random phrases, then the consent statement. */
export function pickPhrases(name: string, language: LikenessLanguage, random: () => number = Math.random): string[] {
  const pool = [...PHRASES[language]];
  const first = pool.splice(Math.floor(random() * pool.length), 1)[0];
  const second = pool.splice(Math.floor(random() * pool.length), 1)[0];
  return [first, second, likenessConsentStatement(name, language)];
}
