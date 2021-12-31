# Desktop batch video compression tool

[Download EXE file](https://github.com/kachurovskiy/batchviproc/raw/main/batchviproc%201.0.0.exe)

<img width="590" alt="batchviproc" src="https://user-images.githubusercontent.com/517919/147787665-09bdd452-f867-4129-9a6d-a1a12659b91d.png">

## Development

Make sure you have Git, Node JS and NPM installed.

```
git clone https://github.com/kachurovskiy/batchviproc.git
cd batchviproc
npm install
npm start
```

# Building EXE file

```
electron-builder --win portable 
```

Delete the created `dist` folder and top-level `exe` file before making the next build or the `exe` file size will jump to over 100Mb.
