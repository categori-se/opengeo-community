# Exchange a camera tour with KML

Open **KML tour exchange** in Camera tour to read one bounded `gx:Tour`. Review
the conversion report before choosing **Use imported camera tour**. Download
controls provide the converted KML, its report and the untouched original input.
The imported camera tour remains editable and uses the existing Project save
workflow. Original exchange files and reports are session downloads rather than
saved Project attachments.

The reader accepts KML 2.2 up to 256 KiB with exactly one `gx:Tour` and one
`gx:Playlist`. Supported FlyTo and Wait primitives become existing camera views
and holds, within the native tour's view, timing and size bounds. LookAt and
representable nadir Camera views are supported. Range/zoom conversion uses a
declared reference viewport; framing and flight interpolation are approximate.

The report identifies omitted audio, object updates, playback controls and
separate KML content. Unsafe XML/resources, network links and unrepresentable
cameras are refused; the reader does not fetch resources or attach Layers.
Native tour JSON retains exact native semantics and Layer events. Narration,
movie encoding and full Google Earth tour parity remain unfinished.
