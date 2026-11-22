import stringWidth from 'string-width';

/** each text approved for the chant cast, with its gloss. */
export const chants: readonly string[] = [
  'Ave Satanas', // hail Satan
  'Hail Satan',
  'Rege Satanas', // reign, Satan
  'Aperite portas inferi', // open the gates of hell
  'Per ignem et sanguinem', // by fire and blood
  'Ego te invoco, Lucifer', // I invoke you, Lucifer
  'Veni, Lucifer, veni', // come, Lucifer, come
  'Sanguis meus, anima mea', // my blood, my soul
  'Tenebrae vocant', // the darkness calls
  'Non serviam', // I will not serve
  'Fiat ignis', // let there be fire
  'Lux e tenebris', // light out of darkness
  'Ex inferis, codex', // from hell, the code
  'In nomine Dei nostri Satanas Luciferi excelsi', // in the name of our god Satan, Lucifer most high
  'Ad maiorem Satanae gloriam', // to the greater glory of Satan
  'Flectere si nequeo superos, Acheronta movebo', // if I cannot bend the heavens, I will raise hell (Virgil)
];

/** fits a row when spaced out, and six words tolled 11 frames apart finish within the cast. */
export const short = chants.filter(
  (text) => stringWidth(text) <= 24 && text.split(' ').length <= 6,
);
