/** Shared mean-sphere/planar sight line. Distances and heights are metres. */
export function sightLineModel({distanceMeters, radiusMeters, observerElevationMeters, targetElevationMeters, curvature = true}) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0 || distanceMeters > 100_000
    || !Number.isFinite(radiusMeters) || radiusMeters < 1_000_000 || radiusMeters > 10_000_000
    || ![observerElevationMeters,targetElevationMeters].every(v=>Number.isFinite(v)&&Math.abs(v)<=102_000)
    || typeof curvature !== "boolean") throw Error("sight_line_model_invalid");
  const angle=distanceMeters/radiusMeters;
  function segment(offset=0) {
    if(!Number.isFinite(offset)||Math.abs(offset)>1000)throw Error("sight_line_offset_invalid");
    return {start:[0,observerElevationMeters+offset],end:curvature
      ? [(radiusMeters+targetElevationMeters+offset)*Math.sin(angle),(radiusMeters+targetElevationMeters+offset)*Math.cos(angle)-radiusMeters]
      : [distanceMeters,targetElevationMeters+offset]};
  }
  function heightAt(distance,offset=0) {
    if(!Number.isFinite(distance)||distance<0||distance>distanceMeters)throw Error("sight_line_distance_invalid");
    if(!Number.isFinite(offset)||Math.abs(offset)>1000)throw Error("sight_line_offset_invalid");
    const t=distance/distanceMeters;
    if(!curvature)return observerElevationMeters+(targetElevationMeters-observerElevationMeters)*t+offset;
    const phi=angle*t,a=radiusMeters+observerElevationMeters+offset,b=radiusMeters+targetElevationMeters+offset;
    return a*b*Math.sin(angle)/(b*Math.sin(angle-phi)+a*Math.sin(phi))-radiusMeters;
  }
  return {heightAt,segment};
}
