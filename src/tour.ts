// Guided tour: a sequence of stops, each a moment and a place, with a short caption. The facts come from the
// timeline in data/events.json (sources noted there: Osprey, Somme 1916; Middlebrook) and the casualty record.
export type TourStop = {
  time: string;                 // HH:MM or HH:MM:SS, the moment the stop shows
  at: { place?: string; feature?: string; mine?: string; ll?: [number, number]; whole?: true };
  dist: number;                 // camera distance in metres
  speed: number;                // playback speed while the stop is shown
  title: string;
  text: string;
  source?: string;
};

export const TOUR: TourStop[] = [
  {
    time: '06:25', at: { whole: true }, dist: 0, speed: 60,
    title: 'The front at dawn',
    text: 'Thirteen British divisions wait along the front from Gommecourt in the north to Maricourt in the south, with the French astride the Somme beyond. After a week of shelling, the final intense bombardment begins at 06:25.',
    source: 'Middlebrook, The First Day on the Somme',
  },
  {
    time: '07:19:57', at: { mine: 'Hawthorn Ridge' }, dist: 1800, speed: 1,
    title: 'Hawthorn Ridge, 07:20',
    text: 'The mine under the Hawthorn Redoubt is blown ten minutes before zero, and VIII Corps’ heavy guns lift off the German front line. The early blast warns the German Reserve Infantry Regiment 119, which counter-attacks at the new crater at 07:25 as two platoons of the 2nd Royal Fusiliers rush it.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '07:25', at: { place: 'Gommecourt' }, dist: 4200, speed: 10,
    title: 'Gommecourt: the diversion',
    text: 'At the northern end, the 46th and 56th Divisions attack the Gommecourt salient from both sides to draw German reserves away from the main attack. A smoke screen is laid at 07:20 and the 56th Division’s leading companies move out into no man’s land.',
  },
  {
    time: '07:27:57', at: { mine: 'Lochnagar' }, dist: 2600, speed: 1,
    title: 'La Boisselle, 07:28',
    text: 'The Lochnagar (60,000 lb) and Y Sap (40,000 lb) mines go up either side of La Boisselle. The 34th Division, including the Tyneside Scottish and Tyneside Irish, advances on the village from the Tara–Usna ridge, some of it from far behind the front line.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '07:30', at: { ll: [50.0863, 2.6486] }, dist: 1500, speed: 10,
    title: 'Zero hour: the Sunken Lane',
    text: 'B and D Companies of the 1st Lancashire Fusiliers moved into the Sunken Lane in no man’s land by tunnel at 03:00. At 07:30 they attack and are cut down; only about 50 men reach the dip in no man’s land.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '07:30', at: { mine: 'Kasino Point' }, dist: 2600, speed: 10,
    title: 'The south: Carnoy and Montauban',
    text: 'Opposite Carnoy, Captain Nevill of the 8th East Surreys starts his company’s advance by kicking a football towards the German line. The Kasino Point mine is fired late, after the infantry has left its trench. Here the German wire and guns had been badly hit by British and French artillery.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '07:32', at: { place: 'Serre' }, dist: 3000, speed: 10,
    title: 'Serre: the Pals',
    text: 'The 31st Division’s Pals battalions – from Accrington, Sheffield, Leeds, Bradford and Barnsley – attack Serre from the line of copses. Machine guns and artillery stop them in no man’s land. By night nothing is held, though a few men were reported in Serre itself.',
  },
  {
    time: '07:33', at: { feature: 'Schwaben Redoubt (Feste Schwaben)' }, dist: 3200, speed: 10,
    title: 'The Ulster Division',
    text: 'The 36th (Ulster) Division crept out of Thiepval Wood before the barrage lifted and rushed the German front line. By 08:30 it has taken the Schwaben Redoubt; by 10:00 parts of the 107th Brigade are near the German second line at Stuff Redoubt, caught by their own barrage.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '09:15', at: { ll: [50.07391, 2.64837] }, dist: 1700, speed: 10,
    title: 'Beaumont-Hamel: the Newfoundlanders',
    text: 'With the first attack already failed, the 1st Newfoundland Regiment is sent forward at 09:15 from the third line, in the open and under full view. Few reach no man’s land; the battalion loses 710 men.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '10:20', at: { place: 'Montauban' }, dist: 3000, speed: 10,
    title: 'Montauban taken',
    text: 'At 10:30 the 30th Division captures Montauban. By 11:00 it has reached Montauban Alley beyond the village, and the 16th Manchesters capture field guns. In the south, almost every objective falls.',
    source: 'Osprey, Somme 1916',
  },
  {
    time: '14:33', at: { place: 'Fricourt' }, dist: 2800, speed: 10,
    title: 'Fricourt, 14:33',
    text: 'The 50th Brigade (7th East Yorks, 7th Green Howards) attacks Fricourt after only a weak bombardment and fails. Fricourt is left between the 7th and 21st Divisions’ gains; the Germans withdraw from it the next night.',
  },
  {
    time: '16:00', at: { feature: 'Schwaben Redoubt (Feste Schwaben)' }, dist: 3600, speed: 10,
    title: 'The Schwaben Redoubt lost',
    text: 'German counter-attacks close on the Schwaben Redoubt from three sides through the afternoon. With the divisions on both flanks held up, the Ulstermen run short of bombs; by 22:30 only about 750 yards of the German front line is still held.',
    source: 'German regimental maps; Osprey, Somme 1916',
  },
  {
    time: '22:20', at: { whole: true }, dist: 0, speed: 10,
    title: 'Nightfall',
    text: 'South of the Albert–Bapaume road the line has moved forward up to a mile; north of it, almost nothing has been gained. The day cost the British Army 57,470 casualties, 19,240 of them killed – the worst day in its history.',
    source: 'Middlebrook, The First Day on the Somme',
  },
];
