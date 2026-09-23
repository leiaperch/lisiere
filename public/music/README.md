# La musique de fond

Le fichier en place est **`fond.mp3`** : c'est le seul nom que la balade cherche
(`src/sound.ts`, méthode `music()`). Pour changer de morceau, remplacer ce
fichier, rien d'autre à toucher.

- Il n'est chargé qu'à l'activation du bouton **Son**, pas au démarrage.
- Il est décodé puis rebouclé à l'échantillon près, donc il doit reboucler
  proprement de lui-même : pas de silence ni de note qui retombe à la fin.
- Son volume suit l'avancée de la balade (entrée après les premiers pas, retrait
  quand les grillons montent, retour à l'arrivée).
- S'il est absent, la balade tourne sans musique et rien ne casse.

Viser 3 à 6 minutes et moins de 5 Mo : le dépôt est servi par GitHub Pages, et
tout le fichier est téléchargé avant la première note.

## Le morceau actuel

Ambiant instrumental généré le 2026-09-23 avec Lyria 3 Pro (MCP Artlist), puis
monté en boucle : 2 min 53, 2,8 Mo, mp3 128 kbit/s.

Le montage compte autant que la génération. Un morceau généré s'arrête comme il
s'arrête, et la couture s'entend à chaque tour. Les sept premières secondes ont
donc été coupées et fondues en croix avec la fin, ce qui fait tomber la reprise
au milieu d'un son continu :

```bash
ffmpeg -i source.mp3 -filter_complex "[0]atrim=0:7,asetpts=N/SR/TB[h];[0]atrim=7,asetpts=N/SR/TB[b];[b][h]acrossfade=d=7:c1=tri:c2=tri[o]" -map "[o]" -codec:a libmp3lame -b:a 128k fond.mp3
```
