# 🐱 Chat & Souris 🐭

Jeu de chasse à l'homme en extérieur pour **deux téléphones**. Application web
installable (PWA) : pas besoin de store, on ouvre le lien et on peut l'ajouter
à l'écran d'accueil.

## Déroulement

1. **Lancer une partie** (gros bouton de l'accueil).
2. **Délimiter la zone de jeu** sur la carte : un cercle (centre + rayon) ou un
   polygone (on touche les coins).
3. **Choisir les paramètres** :
   - durée totale de la partie ;
   - avance de la souris (ex. 10 min) ;
   - position de la souris pendant la chasse : en direct, révélée toutes les
     N minutes, **zone qui se rétrécit**, ou cachée ;
   - points par photo du chat et délai entre deux photos.
4. **Connecter l'autre téléphone** : il appuie sur « Rejoindre » et tape le
   code à 6 caractères affiché sur le premier.
5. **Tirage au sort synchronisé** : les deux écrans tournent en même temps et
   désignent le chat 🐱 et la souris 🐭.
6. **Phase de fuite** (durée de l'avance) : un timer se lance sur les deux
   téléphones. Le chat voit la position de la souris en direct sur la carte ;
   la souris ne voit que son timer.
7. **Chasse** : la souris ne voit plus qu'un timer et un gros bouton
   **« Je suis touché ! »**. Le chat voit la position selon le paramètre choisi.
   Quand la souris est touchée, les rôles s'inversent et une nouvelle phase de
   fuite commence.
8. **Fin** : à la fin du temps imparti, celui qui a **le plus de points** gagne.

## Points

- **Temps en souris** : rester souris pendant toute la partie rapporte
  1000 pts. Le gain par minute dépend donc de la durée de la partie
  (60 min → 16,7 pts/min, 30 min → 33,3 pts/min).
- **Photo du chat** (100 pts par défaut) : pendant la chasse, la souris
  photographie le visage du chat avec le bouton 📸. Le chat reçoit la photo et
  la valide ou la refuse ; sans réponse en 90 s, elle est validée
  automatiquement. Une photo encore en attente à la fin de la partie compte.
  Contrepartie : la photo **révèle au chat l'endroit où elle a été prise**.
  Il faut attendre un délai (3 min par défaut) entre deux photos.

## Zone qui se rétrécit

Pendant la chasse, le chat ne voit pas la souris mais un cercle qui la contient,
sans être centré sur elle. Le cercle est recalculé toutes les 20 s et son
rayon diminue du rayon de départ (500 m par défaut) au rayon final (30 m) sur
la durée choisie. Quand la souris est touchée, le cercle repart du rayon de
départ.

Bonus : alerte (vibration + bip) si on sort de la zone, écran maintenu allumé,
reprise de la partie si l'appli est fermée ou rechargée.

## Installation / hébergement

La géolocalisation exige HTTPS. Le plus simple : **GitHub Pages**.

1. Fusionner ce code sur `main`.
2. Dans le dépôt GitHub : *Settings → Pages → Source : GitHub Actions*.
3. Le workflow `.github/workflows/pages.yml` publie le site à chaque push sur
   `main`. Ouvrir l'URL sur les deux téléphones (puis « Ajouter à l'écran
   d'accueil »).

N'importe quel hébergement statique HTTPS marche aussi (Netlify, Vercel…).

## Technique

- HTML/CSS/JS sans build, bibliothèques incluses dans `vendor/`
  ([Leaflet](https://leafletjs.com) pour la carte OpenStreetMap,
  [MQTT.js](https://github.com/mqttjs/MQTT.js) pour la connexion).
- Les téléphones communiquent via un serveur MQTT public
  (`broker.hivemq.com` par défaut, modifiable dans « Avancé »). Ça marche en
  4G/5G sans être sur le même Wi-Fi.
- Messages **chiffrés** (AES-GCM, clé dérivée du code de partie) ; le nom du
  canal est un hash du code.
- Le téléphone qui crée la partie fait autorité ; l'autre synchronise son
  horloge par ping/pong, ce qui aligne tirage et timers.

### Tester en local

```sh
npx http-server -p 8080
# ouvrir http://localhost:8080 dans deux onglets
# (option ?broker=ws://localhost:8888 pour un serveur MQTT local)
```
