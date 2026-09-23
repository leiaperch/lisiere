# La musique de fond

Déposer ici le fichier **`fond.mp3`** : c'est le seul nom que la balade cherche
(`src/sound.ts`, méthode `music()`). Rien d'autre à changer.

- Le fichier n'est chargé qu'à l'activation du bouton **Son**, pas au démarrage.
- Il est décodé puis rebouclé à l'échantillon près : le morceau doit donc être
  choisi pour boucler proprement, ou coupé sur une mesure pleine.
- Son volume suit l'avancée de la balade (entrée après les premiers pas, retrait
  quand les grillons montent, retour à l'arrivée).
- S'il est absent, la balade tourne sans musique et rien ne casse.

Viser 3 à 6 minutes et moins de 5 Mo : le dépôt est servi par GitHub Pages, et
tout le fichier est téléchargé avant la première note.
