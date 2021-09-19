import { Vector3 } from 'three';

const tempVector = new Vector3();
const tempVector1 = new Vector3();
const tempVector2 = new Vector3();

export const EPSILON = 1e-7;

// https://docs.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_standard_multisample_quality_levels
export const ANTIALIAS_WIDTH = 16;
export const ANTIALIAS_OFFSETS = [
	[ 1, 1 ], [ - 1, - 3 ], [ - 3, 2 ], [ 4, - 1 ],
	[ - 5, - 2 ], [ 2, 5 ], [ 5, 3 ], [ 3, - 5 ],
	[ - 2, 6 ], [ 0, - 7 ], [ - 4, - 6 ], [ - 6, 4 ],
	[ - 8, 0 ], [ 7, - 4 ], [ 6, 7 ], [ - 7, - 8 ],
];

export function schlickFresnelReflectance( cosine, iorRatio ) {

	// Schlick approximation
	const r0 = Math.pow( ( 1 - iorRatio ) / ( 1 + iorRatio ), 2 );
	return r0 + ( 1 - r0 ) * Math.pow( 1.0 - cosine, 5 );

}

export function refract( dir, norm, iorRatio, target ) {

	// snell's law
	// ior1 * sin( t1 ) = ior2 * sin( t2 )
	let cosTheta = Math.min( - dir.dot( norm ), 1.0 );

	tempVector
		.copy( dir )
		.addScaledVector( norm, cosTheta )
		.multiplyScalar( iorRatio );

	target
		.copy( norm )
		.multiplyScalar( - Math.sqrt( Math.abs( 1.0 - tempVector.lengthSq() ) ) )
		.add( tempVector );

}

// forms a basis with the normal vector as Z
export function getBasisFromNormal( normal, targetMatrix ) {

	if ( Math.abs( normal.x ) > 0.5 ) {

		tempVector.set( 0, 1, 0 );

	} else {

		tempVector.set( 1, 0, 0 );

	}

	tempVector1.crossVectors( normal, tempVector ).normalize();
	tempVector2.crossVectors( normal, tempVector1 ).normalize();
	targetMatrix.makeBasis( tempVector2, tempVector1, normal );

}

export function getHalfVector( a, b, target ) {

	return target.addVectors( a, b ).normalize();

}

export function getRandomUnitDirection( target ) {

	const u = ( Math.random() - 0.5 ) * 2;
	const t = Math.random() * Math.PI * 2;
	const f = Math.sqrt( 1 - u ** 2 );

	target.x = f * Math.cos( t );
	target.y = f * Math.sin( t );
	target.z = u;

	return target;

}
